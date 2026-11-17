//! Apple Calendar capability: read-only EventKit access (macOS).
//!
//! Rust owns the capability only — requesting access, listing calendars, and
//! listing events for a date range. Which calendars are enabled, how events
//! are filtered (declined, all-day), and what markdown an event turns into
//! are policy in `@reflect/core`. Events are fetched live and never
//! persisted; the SQLite index stays a projection of markdown only
//! (docs/porting/calendar-meetings-integration.md).
//!
//! macOS Calendar already aggregates Google / Microsoft / iCloud accounts, so
//! this one local integration reaches them all with zero credentials and no
//! network access. Other platforms get a fail-loud stub with the identical
//! command surface.

use std::sync::Arc;

use reflect_core::Core;
use reflect_types::{CalendarAuthorizationStatus, CalendarEvent, CalendarInfo};
use tauri::State;

use crate::error::AppResult;

/// Command: the current EventKit authorization state for events.
#[tauri::command]
pub fn calendar_authorization_status() -> AppResult<CalendarAuthorizationStatus> {
    platform::authorization_status()
}

/// Command: trigger the macOS calendar permission prompt (first call only —
/// the OS remembers the answer) and resolve with whether full access is
/// granted. Runs off the main thread because the completion waits on the user.
#[tauri::command]
pub async fn calendar_request_access(core: State<'_, Arc<Core>>) -> AppResult<bool> {
    core.spawn_blocking(platform::request_access).await
}

/// Command: every event calendar on this Mac, across all accounts. Like the
/// events listing, installs the change observer — the Settings section
/// subscribes to `calendar:changed` before any events are ever fetched.
#[tauri::command]
pub async fn calendar_list_calendars(
    app: tauri::AppHandle,
    core: State<'_, Arc<Core>>,
) -> AppResult<Vec<CalendarInfo>> {
    platform::ensure_change_observer(&app);
    core.spawn_blocking(platform::list_calendars).await
}

/// Command: events from the given calendars overlapping `[start, end]`
/// (epoch milliseconds). Also installs the change observer so subsequent
/// external edits reach the frontend as `calendar:changed` events.
#[tauri::command]
pub async fn calendar_list_events(
    app: tauri::AppHandle,
    start: f64,
    end: f64,
    calendar_ids: Vec<String>,
    core: State<'_, Arc<Core>>,
) -> AppResult<Vec<CalendarEvent>> {
    platform::ensure_change_observer(&app);
    core.spawn_blocking(move || platform::list_events(start, end, &calendar_ids))
        .await
}

#[cfg(target_os = "macos")]
mod platform {
    use std::ptr::NonNull;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc;

    use block2::{DynBlock, RcBlock};
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, Bool};
    use objc2::sel;
    use objc2_app_kit::NSColorSpace;
    use objc2_event_kit::{
        EKAuthorizationStatus, EKCalendar, EKEntityType, EKEvent, EKEventAvailability,
        EKEventStatus, EKEventStore, EKEventStoreChangedNotification, EKParticipant,
        EKParticipantStatus, EKParticipantType,
    };
    use objc2_foundation::{
        NSArray, NSDate, NSError, NSNotification, NSNotificationCenter, NSObjectProtocol, NSString,
    };
    use tauri::Emitter;

    use crate::error::{AppError, AppResult};
    use reflect_types::{
        CalendarAttendee, CalendarAttendeeStatus, CalendarAuthorizationStatus,
        CalendarAvailability, CalendarEvent, CalendarInfo,
    };

    pub fn authorization_status() -> AppResult<CalendarAuthorizationStatus> {
        let status = unsafe { EKEventStore::authorizationStatusForEntityType(EKEntityType::Event) };
        Ok(match status {
            EKAuthorizationStatus::NotDetermined => CalendarAuthorizationStatus::NotDetermined,
            EKAuthorizationStatus::Restricted => CalendarAuthorizationStatus::Restricted,
            EKAuthorizationStatus::Denied => CalendarAuthorizationStatus::Denied,
            EKAuthorizationStatus::FullAccess => CalendarAuthorizationStatus::FullAccess,
            EKAuthorizationStatus::WriteOnly => CalendarAuthorizationStatus::WriteOnly,
            _ => CalendarAuthorizationStatus::Denied,
        })
    }

    pub fn request_access() -> AppResult<bool> {
        let store = unsafe { EKEventStore::new() };
        let (sender, receiver) = mpsc::channel::<bool>();
        let handler = RcBlock::new(move |granted: Bool, _error: *mut NSError| {
            let _ = sender.send(granted.as_bool());
        });
        let handler_ptr: *mut DynBlock<dyn Fn(Bool, *mut NSError)> =
            &*handler as *const _ as *mut _;
        unsafe {
            if store.respondsToSelector(sel!(requestFullAccessToEventsWithCompletion:)) {
                store.requestFullAccessToEventsWithCompletion(handler_ptr);
            } else {
                // macOS 13 and earlier, before the full/write-only split.
                #[allow(deprecated)]
                store.requestAccessToEntityType_completion(EKEntityType::Event, handler_ptr);
            }
        }
        // `store` and `handler` stay alive on this thread until the user
        // answers the system prompt and the completion fires.
        receiver.recv().map_err(|_| AppError::Unknown {
            message: "calendar access request did not complete".into(),
        })
    }

    pub fn list_calendars() -> AppResult<Vec<CalendarInfo>> {
        let store = unsafe { EKEventStore::new() };
        let calendars = unsafe { store.calendarsForEntityType(EKEntityType::Event) };
        Ok(calendars
            .iter()
            .map(|calendar| describe_calendar(&calendar))
            .collect())
    }

    pub fn list_events(
        start_ms: f64,
        end_ms: f64,
        calendar_ids: &[String],
    ) -> AppResult<Vec<CalendarEvent>> {
        if calendar_ids.is_empty() {
            return Ok(Vec::new());
        }
        let store = unsafe { EKEventStore::new() };
        // Identifiers can go stale when accounts sync; skipping unknown ones
        // (instead of erroring) keeps a renamed account from wedging the panel.
        let calendars: Vec<Retained<EKCalendar>> = calendar_ids
            .iter()
            .filter_map(|id| unsafe { store.calendarWithIdentifier(&NSString::from_str(id)) })
            .collect();
        if calendars.is_empty() {
            return Ok(Vec::new());
        }
        let calendar_array = NSArray::from_retained_slice(&calendars);
        let start = NSDate::dateWithTimeIntervalSince1970(start_ms / 1000.0);
        let end = NSDate::dateWithTimeIntervalSince1970(end_ms / 1000.0);
        let predicate = unsafe {
            store.predicateForEventsWithStartDate_endDate_calendars(
                &start,
                &end,
                Some(&calendar_array),
            )
        };
        let events = unsafe { store.eventsMatchingPredicate(&predicate) };
        Ok(events.iter().map(|event| describe_event(&event)).collect())
    }

    static OBSERVER_INSTALLED: AtomicBool = AtomicBool::new(false);

    /// Install (once per process) a long-lived event store observing
    /// `EKEventStoreChangedNotification`, re-broadcast to the frontend as
    /// `calendar:changed` so it can refetch instead of polling. The store and
    /// observer token are deliberately leaked — they must outlive every
    /// future read, and there is nothing to tear down before exit.
    pub fn ensure_change_observer(app: &tauri::AppHandle) {
        if OBSERVER_INSTALLED.swap(true, Ordering::SeqCst) {
            return;
        }
        let handle = app.clone();
        let scheduled = app.run_on_main_thread(move || {
            let store = unsafe { EKEventStore::new() };
            let store_object: &AnyObject = &store;
            let block = RcBlock::new(move |_notification: NonNull<NSNotification>| {
                let _ = handle.emit("calendar:changed", ());
            });
            let center = NSNotificationCenter::defaultCenter();
            let token = unsafe {
                center.addObserverForName_object_queue_usingBlock(
                    Some(EKEventStoreChangedNotification),
                    Some(store_object),
                    None,
                    &block,
                )
            };
            std::mem::forget(token);
            std::mem::forget(store);
        });
        // A failed dispatch (e.g. mid-shutdown) must not mark the observer
        // installed, or the next read would never retry attaching it.
        if scheduled.is_err() {
            OBSERVER_INSTALLED.store(false, Ordering::SeqCst);
        }
    }

    fn describe_calendar(calendar: &EKCalendar) -> CalendarInfo {
        let source = unsafe { calendar.source() }
            .map(|source| unsafe { source.title() }.to_string())
            .unwrap_or_default();
        CalendarInfo {
            id: unsafe { calendar.calendarIdentifier() }.to_string(),
            title: unsafe { calendar.title() }.to_string(),
            source,
            color: calendar_color_hex(calendar),
        }
    }

    fn calendar_color_hex(calendar: &EKCalendar) -> Option<String> {
        let color = unsafe { calendar.color() };
        let srgb = color.colorUsingColorSpace(&NSColorSpace::sRGBColorSpace())?;
        let to_byte = |component: f64| (component.clamp(0.0, 1.0) * 255.0).round() as u8;
        Some(format!(
            "#{:02x}{:02x}{:02x}",
            to_byte(srgb.redComponent()),
            to_byte(srgb.greenComponent()),
            to_byte(srgb.blueComponent()),
        ))
    }

    fn describe_event(event: &EKEvent) -> CalendarEvent {
        // `title` is declared non-null but synced events have shipped nil
        // titles in the wild — read it nullably instead of trusting the
        // binding's Retained return.
        let title: Option<Retained<NSString>> = unsafe { objc2::msg_send![event, title] };
        let identifier = unsafe { event.eventIdentifier() }
            .map(|id| id.to_string())
            .unwrap_or_else(|| unsafe { event.calendarItemIdentifier() }.to_string());
        let calendar_id = unsafe { event.calendar() }
            .map(|calendar| unsafe { calendar.calendarIdentifier() }.to_string())
            .unwrap_or_default();
        let attendees = unsafe { event.attendees() }
            .map(|list| {
                list.iter()
                    .map(|attendee| describe_attendee(&attendee))
                    .collect()
            })
            .unwrap_or_default();
        let availability = match unsafe { event.availability() } {
            EKEventAvailability::Busy => CalendarAvailability::Busy,
            EKEventAvailability::Free => CalendarAvailability::Free,
            EKEventAvailability::Tentative => CalendarAvailability::Tentative,
            EKEventAvailability::Unavailable => CalendarAvailability::Unavailable,
            _ => CalendarAvailability::NotSupported,
        };
        CalendarEvent {
            id: identifier,
            calendar_id,
            title: title.map(|title| title.to_string()).unwrap_or_default(),
            starts_at: unsafe { event.startDate() }.timeIntervalSince1970() * 1000.0,
            ends_at: unsafe { event.endDate() }.timeIntervalSince1970() * 1000.0,
            all_day: unsafe { event.isAllDay() },
            recurring: unsafe { event.hasRecurrenceRules() },
            availability,
            canceled: unsafe { event.status() } == EKEventStatus::Canceled,
            attendees,
        }
    }

    fn describe_attendee(attendee: &EKParticipant) -> CalendarAttendee {
        let address = unsafe { attendee.URL() }
            .absoluteString()
            .map(|absolute| absolute.to_string());
        let email = address
            .as_deref()
            .and_then(|absolute| absolute.strip_prefix("mailto:"))
            .filter(|candidate| !candidate.is_empty())
            .map(str::to_string);
        let name = unsafe { attendee.name() }
            .map(|name| name.to_string())
            .or_else(|| email.clone())
            .or(address)
            .unwrap_or_default();
        let status = match unsafe { attendee.participantStatus() } {
            EKParticipantStatus::Accepted => CalendarAttendeeStatus::Accepted,
            EKParticipantStatus::Declined => CalendarAttendeeStatus::Declined,
            EKParticipantStatus::Tentative => CalendarAttendeeStatus::Tentative,
            EKParticipantStatus::Pending => CalendarAttendeeStatus::Pending,
            _ => CalendarAttendeeStatus::Unknown,
        };
        CalendarAttendee {
            name,
            email,
            is_current_user: unsafe { attendee.isCurrentUser() },
            is_person: unsafe { attendee.participantType() } == EKParticipantType::Person,
            status,
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use crate::error::{AppError, AppResult};
    use reflect_types::{CalendarAuthorizationStatus, CalendarEvent, CalendarInfo};

    fn unsupported<T>() -> AppResult<T> {
        Err(AppError::Unknown {
            message: "calendar integration is only available on macOS".into(),
        })
    }

    pub fn authorization_status() -> AppResult<CalendarAuthorizationStatus> {
        unsupported()
    }

    pub fn request_access() -> AppResult<bool> {
        unsupported()
    }

    pub fn list_calendars() -> AppResult<Vec<CalendarInfo>> {
        unsupported()
    }

    pub fn list_events(
        _start_ms: f64,
        _end_ms: f64,
        _calendar_ids: &[String],
    ) -> AppResult<Vec<CalendarEvent>> {
        unsupported()
    }

    pub fn ensure_change_observer(_app: &tauri::AppHandle) {}
}
