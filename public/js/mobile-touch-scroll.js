// Touch scrolling for terminals whose application owns the mouse, and
// keyboard dismissal for every terminal drag.
//
// xterm 6.1.0-beta translates one-finger drags into wheel mouse reports, but
// its synthesized gesture events carry no client coordinates, so the reports
// are dropped or emitted with NaN coordinates: mouse-tracking TUIs like Grok
// never scroll and can receive corrupt input. Until that is fixed upstream,
// this module claims one-finger vertical drags while mouse tracking is active
// and writes row-quantized SGR wheel reports itself. Sessions without mouse
// tracking keep xterm's native touch scrolling, and Select mode keeps
// priority over one-finger drags.
//
// Recognizing a vertical drag also reports it through onDragClaim so the
// Composer can drop the Android keyboard: scrolling the terminal means
// reading, not typing.

const DRAG_SLOP_PX = 8;
const LONG_PRESS_MS = 500;
const MOMENTUM_MIN_VELOCITY = 0.05; // px per ms
const MOMENTUM_DECAY = 0.94;        // per animation frame

function touchFrom(list, identifier = null) {
  if (!list) return null;
  for (let index = 0; index < list.length; index += 1) {
    const touch = list.item ? list.item(index) : list[index];
    if (touch && (identifier === null || touch.identifier === identifier)) return touch;
  }
  return null;
}

export function createMobileTouchScroll({ isSelectionActive, sendInput, onDragClaim, onLongPress, onTap, onAppScroll }) {
  const attachments = new Map();

  function attach(id, term, host) {
    detach(id);
    const screen = host.querySelector('.xterm-screen');
    if (!screen) return;

    let touchId = null;
    let claimed = false;
    let startX = 0;
    let startY = 0;
    let lastY = 0;
    let accumulator = 0;
    let lastColumn = 1;
    let lastRow = 1;
    let velocity = 0;
    let lastMoveAt = 0;
    let longPressTimer = 0;
    let momentumRaf = 0;

    const cancelLongPress = () => {
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = 0; }
    };
    const cancelMomentum = () => {
      if (momentumRaf) { cancelAnimationFrame(momentumRaf); momentumRaf = 0; }
      velocity = 0;
    };
    const reset = () => {
      touchId = null;
      claimed = false;
      accumulator = 0;
      cancelLongPress();
    };
    const tracking = () => term.modes.mouseTrackingMode !== 'none';

    // Emit whole-row SGR wheel reports for whatever the accumulator holds.
    const emitSteps = () => {
      const rect = screen.getBoundingClientRect();
      if (!rect.width || !rect.height || !term.cols || !term.rows) return;
      const cellHeight = rect.height / term.rows;
      const steps = Math.trunc(accumulator / cellHeight);
      if (!steps) return;
      accumulator -= steps * cellHeight;
      // Finger moving up reveals later content: wheel down (65). Finger
      // moving down reveals earlier content: wheel up (64).
      const button = steps > 0 ? 65 : 64;
      // SGR (1006) encoding: every mouse-tracking TUI CliDeck hosts
      // negotiates it alongside tracking. Reports go straight to the PTY:
      // the terminal onData bridge drops xterm-originated input while the
      // Composer owns input.
      sendInput(id, `\u001b[<${button};${lastColumn};${lastRow}M`.repeat(Math.abs(steps)));
      // The app owns its scrollback, so xterm's viewport never records this
      // movement; report it so the jump-to-latest button can track it.
      onAppScroll?.(id, steps);
    };

    // Flick momentum: keep emitting decaying wheel reports after the finger
    // lifts, matching the native scrollback feel of non-tracking sessions.
    const startMomentum = () => {
      cancelMomentum();
      if (Math.abs(velocity) <= MOMENTUM_MIN_VELOCITY) { velocity = 0; return; }
      let lastFrameAt = 0;
      const stepFrame = now => {
        momentumRaf = 0;
        if (isSelectionActive() || !tracking()) { velocity = 0; return; }
        const dt = lastFrameAt ? Math.min(50, now - lastFrameAt) : 16;
        lastFrameAt = now;
        accumulator += velocity * dt;
        velocity *= MOMENTUM_DECAY;
        emitSteps();
        if (Math.abs(velocity) > MOMENTUM_MIN_VELOCITY) momentumRaf = requestAnimationFrame(stepFrame);
        else velocity = 0;
      };
      momentumRaf = requestAnimationFrame(stepFrame);
    };

    const onTouchStart = event => {
      cancelMomentum();
      if (isSelectionActive() || event.touches.length !== 1) {
        reset();
        return;
      }
      const touch = touchFrom(event.changedTouches) || touchFrom(event.touches);
      if (!touch) return;
      touchId = touch.identifier;
      claimed = false;
      accumulator = 0;
      startX = touch.clientX;
      startY = touch.clientY;
      lastY = touch.clientY;
      lastMoveAt = 0;
      velocity = 0;
      // A still finger held on the terminal arms Select mode: cancelled by
      // any movement past the drag slop, a second finger, or lifting.
      cancelLongPress();
      if (onLongPress) {
        longPressTimer = setTimeout(() => {
          longPressTimer = 0;
          if (touchId !== null && !claimed && !isSelectionActive()) {
            reset();
            onLongPress();
          }
        }, LONG_PRESS_MS);
      }
    };

    const onTouchMove = event => {
      if (touchId === null || isSelectionActive()) return;
      const touch = touchFrom(event.changedTouches, touchId) || touchFrom(event.touches, touchId);
      if (!touch) return;
      if (!claimed) {
        const dx = Math.abs(touch.clientX - startX);
        const dy = Math.abs(touch.clientY - startY);
        if (dx >= DRAG_SLOP_PX || dy >= DRAG_SLOP_PX) cancelLongPress();
        if (dy < DRAG_SLOP_PX) {
          if (dx >= DRAG_SLOP_PX && dx > dy) reset();
          return;
        }
        if (dx > dy) {
          reset();
          return;
        }
        claimed = true;
        lastY = touch.clientY;
        onDragClaim?.();
      }
      // Sessions without mouse tracking keep xterm's native touch scrolling:
      // recognize the drag for onDragClaim but do not consume it.
      if (!tracking()) return;
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
      const dy = lastY - touch.clientY;
      accumulator += dy;
      lastY = touch.clientY;
      const now = performance.now();
      const dt = now - lastMoveAt;
      velocity = lastMoveAt && dt > 0 && dt < 120 ? dy / dt : 0;
      lastMoveAt = now;
      const rect = screen.getBoundingClientRect();
      if (!rect.width || !rect.height || !term.cols || !term.rows) return;
      lastColumn = Math.min(term.cols, Math.max(1, Math.ceil((touch.clientX - rect.left) * term.cols / rect.width)));
      lastRow = Math.min(term.rows, Math.max(1, Math.ceil((touch.clientY - rect.top) * term.rows / rect.height)));
      emitSteps();
    };

    const onTouchEnd = event => {
      if (touchId === null) return;
      const touch = touchFrom(event.changedTouches, touchId);
      if (!touch) return;
      if (claimed && tracking()) {
        if (event.cancelable) event.preventDefault();
        event.stopPropagation();
        startMomentum();
      } else if (!claimed && !isSelectionActive() && onTap?.(id, term, screen, touch)) {
        // xterm's link provider is hover-driven and touch browsers do not
        // reliably synthesize its mouse activation sequence. Suppress the
        // delayed compatibility click after onTap activates the link once.
        if (event.cancelable) event.preventDefault();
        event.stopPropagation();
      }
      reset();
    };

    const onTouchCancel = () => { cancelMomentum(); reset(); };

    const touchOptions = { capture: true, passive: false };
    screen.addEventListener('touchstart', onTouchStart, touchOptions);
    screen.addEventListener('touchmove', onTouchMove, touchOptions);
    screen.addEventListener('touchend', onTouchEnd, touchOptions);
    screen.addEventListener('touchcancel', onTouchCancel, touchOptions);

    attachments.set(id, {
      // Jumping to latest must also stop a decaying flick, or its remaining
      // wheel reports immediately scroll the app away from the bottom again.
      interrupt() {
        cancelMomentum();
      },
      dispose() {
        cancelMomentum();
        cancelLongPress();
        screen.removeEventListener('touchstart', onTouchStart, touchOptions);
        screen.removeEventListener('touchmove', onTouchMove, touchOptions);
        screen.removeEventListener('touchend', onTouchEnd, touchOptions);
        screen.removeEventListener('touchcancel', onTouchCancel, touchOptions);
      },
    });
  }

  function detach(id) {
    attachments.get(id)?.dispose();
    attachments.delete(id);
  }

  function interrupt(id) {
    attachments.get(id)?.interrupt?.();
  }

  return { attach, detach, interrupt };
}
