//! macOS Window menu additions.
//!
//! Tauri/muda installs the standard Window menu (minimize, zoom, close), but
//! it does not expose macOS's newer Move & Resize commands. Add native
//! `NSMenuItem`s so the menu bar and Fn-Control system shortcuts work in the
//! desktop app.

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{define_class, msg_send, sel, DefinedClass, MainThreadOnly};
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};

use objc2_app_kit::{
    NSApplication, NSDownArrowFunctionKey, NSEventModifierFlags, NSLeftArrowFunctionKey, NSMenu,
    NSMenuItem, NSRightArrowFunctionKey, NSScreen, NSUpArrowFunctionKey, NSWindow,
};
use objc2_foundation::{
    ns_string, MainThreadMarker, NSObject, NSObjectProtocol, NSPoint, NSRect, NSString,
};

const TAG_FILL: isize = 1;
const TAG_CENTER: isize = 2;
const TAG_LEFT: isize = 3;
const TAG_RIGHT: isize = 4;
const TAG_TOP: isize = 5;
const TAG_BOTTOM: isize = 6;
const TAG_TOP_LEFT: isize = 7;
const TAG_TOP_RIGHT: isize = 8;
const TAG_BOTTOM_LEFT: isize = 9;
const TAG_BOTTOM_RIGHT: isize = 10;
const TAG_PREVIOUS_SIZE: isize = 11;

#[derive(Debug, Default)]
struct WindowLayoutMenuTargetIvars {
    previous_frames: RefCell<HashMap<isize, NSRect>>,
}

define_class!(
    // SAFETY:
    // - NSObject has no subclassing requirements relevant to this target.
    // - `WindowLayoutMenuTarget` has no drop-sensitive ivars.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = WindowLayoutMenuTargetIvars]
    struct WindowLayoutMenuTarget;

    impl WindowLayoutMenuTarget {
        #[unsafe(method(runWindowLayoutCommand:))]
        fn run_window_layout_command(&self, sender: &NSMenuItem) {
            self.run_command(sender.tag());
        }
    }

    // SAFETY: NSObjectProtocol has no additional safety requirements.
    unsafe impl NSObjectProtocol for WindowLayoutMenuTarget {}
);

impl WindowLayoutMenuTarget {
    fn new(mtm: MainThreadMarker) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(WindowLayoutMenuTargetIvars::default());
        // SAFETY: NSObject's `init` has the expected Objective-C signature.
        unsafe { msg_send![super(this), init] }
    }

    fn run_command(&self, tag: isize) {
        let Some(window) = active_window() else {
            return;
        };
        let Some(screen) = window.screen().or_else(|| NSScreen::mainScreen(self.mtm())) else {
            return;
        };
        let visible = screen.visibleFrame();

        match tag {
            TAG_FILL => self.set_window_frame(&window, visible),
            TAG_CENTER => self.center_window(&window, visible),
            TAG_LEFT => self.set_window_frame(&window, half_frame(visible, Horizontal::Left)),
            TAG_RIGHT => self.set_window_frame(&window, half_frame(visible, Horizontal::Right)),
            TAG_TOP => self.set_window_frame(&window, half_frame(visible, Vertical::Top)),
            TAG_BOTTOM => self.set_window_frame(&window, half_frame(visible, Vertical::Bottom)),
            TAG_TOP_LEFT => {
                self.set_window_frame(
                    &window,
                    quarter_frame(visible, Horizontal::Left, Vertical::Top),
                );
            }
            TAG_TOP_RIGHT => {
                self.set_window_frame(
                    &window,
                    quarter_frame(visible, Horizontal::Right, Vertical::Top),
                );
            }
            TAG_BOTTOM_LEFT => {
                self.set_window_frame(
                    &window,
                    quarter_frame(visible, Horizontal::Left, Vertical::Bottom),
                );
            }
            TAG_BOTTOM_RIGHT => {
                self.set_window_frame(
                    &window,
                    quarter_frame(visible, Horizontal::Right, Vertical::Bottom),
                );
            }
            TAG_PREVIOUS_SIZE => self.restore_previous_frame(&window),
            _ => {}
        }
    }

    fn set_window_frame(&self, window: &NSWindow, frame: NSRect) {
        if !window.isVisible() || window.isMiniaturized() {
            return;
        }
        self.remember_frame(window);
        window.setFrame_display_animate(
            window.constrainFrameRect_toScreen(frame, window.screen().as_deref()),
            true,
            true,
        );
    }

    fn center_window(&self, window: &NSWindow, visible: NSRect) {
        if !window.isVisible() || window.isMiniaturized() {
            return;
        }
        self.remember_frame(window);
        let frame = window.frame();
        let centered = NSRect::new(
            NSPoint::new(
                visible.origin.x + ((visible.size.width - frame.size.width) / 2.0).max(0.0),
                visible.origin.y + ((visible.size.height - frame.size.height) / 2.0).max(0.0),
            ),
            frame.size,
        );
        window.setFrame_display_animate(
            window.constrainFrameRect_toScreen(centered, window.screen().as_deref()),
            true,
            true,
        );
    }

    fn remember_frame(&self, window: &NSWindow) {
        self.prune_closed_window_frames();
        self.ivars()
            .previous_frames
            .borrow_mut()
            .entry(window.windowNumber())
            .or_insert_with(|| window.frame());
    }

    fn restore_previous_frame(&self, window: &NSWindow) {
        self.prune_closed_window_frames();
        let Some(frame) = self
            .ivars()
            .previous_frames
            .borrow_mut()
            .remove(&window.windowNumber())
        else {
            return;
        };
        window.setFrame_display_animate(
            window.constrainFrameRect_toScreen(frame, window.screen().as_deref()),
            true,
            true,
        );
    }

    fn prune_closed_window_frames(&self) {
        let live_window_numbers = self.live_window_numbers();
        prune_frames_for_live_windows(
            &mut self.ivars().previous_frames.borrow_mut(),
            &live_window_numbers,
        );
    }

    fn live_window_numbers(&self) -> HashSet<isize> {
        let app = NSApplication::sharedApplication(self.mtm());
        app.windows()
            .to_vec()
            .iter()
            .map(|window| window.windowNumber())
            .collect()
    }
}

pub fn install() {
    let Some(mtm) = MainThreadMarker::new() else {
        tracing::warn!("macOS Window menu install skipped off the main thread");
        return;
    };

    let app = NSApplication::sharedApplication(mtm);
    let Some(window_menu) = app.windowsMenu() else {
        tracing::warn!("macOS Window menu install skipped because NSApp has no Window menu");
        return;
    };

    if window_menu
        .itemWithTitle(ns_string!("Move & Resize"))
        .is_some()
    {
        return;
    }

    let target = WindowLayoutMenuTarget::new(mtm);
    let move_resize_item = menu_item(mtm, "Move & Resize", None, "", None, Some(&target));
    let move_resize_menu = NSMenu::initWithTitle(NSMenu::alloc(mtm), ns_string!("Move & Resize"));

    add_command(
        &move_resize_menu,
        mtm,
        "Fill",
        TAG_FILL,
        "f",
        base_modifiers(),
        &target,
    );
    add_command(
        &move_resize_menu,
        mtm,
        "Center",
        TAG_CENTER,
        "c",
        base_modifiers(),
        &target,
    );
    move_resize_menu.addItem(&NSMenuItem::separatorItem(mtm));
    add_command(
        &move_resize_menu,
        mtm,
        "Left",
        TAG_LEFT,
        key_equivalent(NSLeftArrowFunctionKey),
        base_modifiers(),
        &target,
    );
    add_command(
        &move_resize_menu,
        mtm,
        "Right",
        TAG_RIGHT,
        key_equivalent(NSRightArrowFunctionKey),
        base_modifiers(),
        &target,
    );
    add_command(
        &move_resize_menu,
        mtm,
        "Top",
        TAG_TOP,
        key_equivalent(NSUpArrowFunctionKey),
        base_modifiers(),
        &target,
    );
    add_command(
        &move_resize_menu,
        mtm,
        "Bottom",
        TAG_BOTTOM,
        key_equivalent(NSDownArrowFunctionKey),
        base_modifiers(),
        &target,
    );
    move_resize_menu.addItem(&NSMenuItem::separatorItem(mtm));
    add_command(
        &move_resize_menu,
        mtm,
        "Top Left",
        TAG_TOP_LEFT,
        "",
        None,
        &target,
    );
    add_command(
        &move_resize_menu,
        mtm,
        "Top Right",
        TAG_TOP_RIGHT,
        "",
        None,
        &target,
    );
    add_command(
        &move_resize_menu,
        mtm,
        "Bottom Left",
        TAG_BOTTOM_LEFT,
        "",
        None,
        &target,
    );
    add_command(
        &move_resize_menu,
        mtm,
        "Bottom Right",
        TAG_BOTTOM_RIGHT,
        "",
        None,
        &target,
    );
    move_resize_menu.addItem(&NSMenuItem::separatorItem(mtm));
    add_command(
        &move_resize_menu,
        mtm,
        "Return to Previous Size",
        TAG_PREVIOUS_SIZE,
        "r",
        base_modifiers(),
        &target,
    );

    move_resize_item.setSubmenu(Some(&move_resize_menu));

    let insertion_index = window_menu.indexOfItemWithTitle(ns_string!("Close Window"));
    if insertion_index >= 0 {
        window_menu.insertItem_atIndex(&move_resize_item, insertion_index);
        window_menu.insertItem_atIndex(&NSMenuItem::separatorItem(mtm), insertion_index + 1);
    } else {
        window_menu.addItem(&NSMenuItem::separatorItem(mtm));
        window_menu.addItem(&move_resize_item);
    }
}

fn add_command(
    menu: &NSMenu,
    mtm: MainThreadMarker,
    title: &str,
    tag: isize,
    key_equivalent: impl AsRef<str>,
    modifiers: Option<NSEventModifierFlags>,
    target: &Retained<WindowLayoutMenuTarget>,
) {
    let item = menu_item(
        mtm,
        title,
        Some(tag),
        key_equivalent.as_ref(),
        modifiers,
        Some(target),
    );
    menu.addItem(&item);
}

fn menu_item(
    mtm: MainThreadMarker,
    title: &str,
    tag: Option<isize>,
    key_equivalent: &str,
    modifiers: Option<NSEventModifierFlags>,
    target: Option<&Retained<WindowLayoutMenuTarget>>,
) -> Retained<NSMenuItem> {
    let item = unsafe {
        NSMenuItem::initWithTitle_action_keyEquivalent(
            NSMenuItem::alloc(mtm),
            &NSString::from_str(title),
            target.map(|_| sel!(runWindowLayoutCommand:)),
            &NSString::from_str(key_equivalent),
        )
    };

    if let Some(tag) = tag {
        item.setTag(tag);
    }
    if let Some(modifiers) = modifiers {
        item.setKeyEquivalentModifierMask(modifiers);
    }
    if let Some(target) = target {
        let target_object: &AnyObject = target.as_ref();
        unsafe {
            item.setTarget(Some(target_object));
            // `target` is weak; representedObject is strong, keeping the
            // action receiver alive for as long as the menu item exists.
            item.setRepresentedObject(Some(target_object));
        }
    }

    item
}

fn active_window() -> Option<Retained<NSWindow>> {
    let mtm = MainThreadMarker::new()?;
    let app = NSApplication::sharedApplication(mtm);
    app.keyWindow().or_else(|| app.mainWindow())
}

fn base_modifiers() -> Option<NSEventModifierFlags> {
    Some(NSEventModifierFlags::Function | NSEventModifierFlags::Control)
}

fn key_equivalent(key: u32) -> String {
    char::from_u32(key).unwrap_or_default().to_string()
}

trait FramePart {
    fn apply(self, frame: NSRect) -> NSRect;
}

#[derive(Clone, Copy)]
enum Horizontal {
    Left,
    Right,
}

#[derive(Clone, Copy)]
enum Vertical {
    Top,
    Bottom,
}

impl FramePart for Horizontal {
    fn apply(self, mut frame: NSRect) -> NSRect {
        frame.size.width /= 2.0;
        if matches!(self, Horizontal::Right) {
            frame.origin.x += frame.size.width;
        }
        frame
    }
}

impl FramePart for Vertical {
    fn apply(self, mut frame: NSRect) -> NSRect {
        frame.size.height /= 2.0;
        if matches!(self, Vertical::Top) {
            frame.origin.y += frame.size.height;
        }
        frame
    }
}

fn half_frame(partition: NSRect, part: impl FramePart) -> NSRect {
    part.apply(partition)
}

fn quarter_frame(partition: NSRect, horizontal: Horizontal, vertical: Vertical) -> NSRect {
    vertical.apply(horizontal.apply(partition))
}

fn prune_frames_for_live_windows(
    previous_frames: &mut HashMap<isize, NSRect>,
    live_window_numbers: &HashSet<isize>,
) {
    previous_frames.retain(|window_number, _frame| live_window_numbers.contains(window_number));
}

#[cfg(test)]
mod tests {
    use super::*;
    use objc2_foundation::NSSize;

    fn frame() -> NSRect {
        NSRect::new(NSPoint::new(100.0, 200.0), NSSize::new(1200.0, 800.0))
    }

    fn assert_frame(actual: NSRect, x: f64, y: f64, width: f64, height: f64) {
        assert_eq!(actual.origin.x, x);
        assert_eq!(actual.origin.y, y);
        assert_eq!(actual.size.width, width);
        assert_eq!(actual.size.height, height);
    }

    #[test]
    fn halves_keep_the_requested_screen_side() {
        assert_frame(
            half_frame(frame(), Horizontal::Left),
            100.0,
            200.0,
            600.0,
            800.0,
        );
        assert_frame(
            half_frame(frame(), Horizontal::Right),
            700.0,
            200.0,
            600.0,
            800.0,
        );
        assert_frame(
            half_frame(frame(), Vertical::Bottom),
            100.0,
            200.0,
            1200.0,
            400.0,
        );
        assert_frame(
            half_frame(frame(), Vertical::Top),
            100.0,
            600.0,
            1200.0,
            400.0,
        );
    }

    #[test]
    fn quarters_keep_the_requested_screen_corner() {
        assert_frame(
            quarter_frame(frame(), Horizontal::Left, Vertical::Top),
            100.0,
            600.0,
            600.0,
            400.0,
        );
        assert_frame(
            quarter_frame(frame(), Horizontal::Right, Vertical::Bottom),
            700.0,
            200.0,
            600.0,
            400.0,
        );
    }

    #[test]
    fn stale_previous_frames_are_pruned() {
        let mut previous_frames = HashMap::from([(11, frame()), (22, frame()), (33, frame())]);
        let live_window_numbers = HashSet::from([22, 33]);

        prune_frames_for_live_windows(&mut previous_frames, &live_window_numbers);

        assert!(!previous_frames.contains_key(&11));
        assert!(previous_frames.contains_key(&22));
        assert!(previous_frames.contains_key(&33));
    }
}
