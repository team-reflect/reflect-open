import type { Locator } from 'vitest/browser'

type EventTarget = Element | Locator

function resolveElement(target: EventTarget): Element {
  return target instanceof Element ? target : target.element()
}

function dispatch(target: EventTarget, event: Event): boolean {
  return resolveElement(target).dispatchEvent(event)
}

function setValue(target: EventTarget, value: string): void {
  const element = resolveElement(target)
  if (element instanceof HTMLTextAreaElement) {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(element, value)
    return
  }
  if (element instanceof HTMLInputElement) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(element, value)
    return
  }
  throw new TypeError('change target must be an input or textarea')
}

export const fireEvent = {
  animationEnd(target: EventTarget): boolean {
    return dispatch(target, new AnimationEvent('animationend', { bubbles: true }))
  },
  change(target: EventTarget, init: { target: { value: string } }): boolean {
    setValue(target, init.target.value)
    dispatch(target, new InputEvent('input', { bubbles: true, inputType: 'insertText' }))
    return dispatch(target, new Event('change', { bubbles: true }))
  },
  click(target: EventTarget, init: MouseEventInit = {}): boolean {
    return dispatch(target, new MouseEvent('click', { bubbles: true, cancelable: true, ...init }))
  },
  focusIn(target: EventTarget): boolean {
    return dispatch(target, new FocusEvent('focusin', { bubbles: true, cancelable: true }))
  },
  keyDown(target: EventTarget, init: KeyboardEventInit = {}): boolean {
    return dispatch(target, new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
  },
  mouseDown(target: EventTarget, init: MouseEventInit = {}): boolean {
    return dispatch(target, new MouseEvent('mousedown', { bubbles: true, cancelable: true, ...init }))
  },
  pointerDown(target: EventTarget, init: PointerEventInit = {}): boolean {
    return dispatch(
      target,
      new PointerEvent('pointerdown', { bubbles: true, cancelable: true, ...init }),
    )
  },
  scroll(target: EventTarget): boolean {
    return dispatch(target, new Event('scroll', { bubbles: true }))
  },
  transitionEnd(target: EventTarget): boolean {
    return dispatch(target, new TransitionEvent('transitionend', { bubbles: true }))
  },
}
