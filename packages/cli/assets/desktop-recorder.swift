import AppKit
import ApplicationServices
import Darwin
import Foundation

struct WindowInfo {
    let id: CGWindowID
    let bounds: CGRect
    let ownerName: String
    let ownerPID: pid_t
    let title: String
    let isOnScreen: Bool
}

// STATE_HARNESS_BEGIN
struct SuppressedMouseDown {
    let gestureID: UUID = UUID()
    let windowID: CGWindowID
    let ownerPID: pid_t
    let point: CGPoint
    let recordsGuideStep: Bool
    var dragged = false
}

struct MouseSuppressionState {
    private(set) var paused = false
    private(set) var pendingMouseDown: SuppressedMouseDown?

    var acceptsMouseDown: Bool { !paused }

    func shouldSuppressMouseDown(recordsGuideStep: Bool, replayPending: Bool) -> Bool {
        recordsGuideStep || replayPending
    }

    @discardableResult
    mutating func togglePause() -> Bool {
        paused.toggle()
        return paused
    }

    mutating func begin(_ mouseDown: SuppressedMouseDown) -> SuppressedMouseDown? {
        let previous = pendingMouseDown
        pendingMouseDown = mouseDown
        return previous
    }

    mutating func takeMouseUp() -> SuppressedMouseDown? {
        defer { pendingMouseDown = nil }
        return pendingMouseDown
    }

    mutating func markDragged() -> SuppressedMouseDown? {
        pendingMouseDown?.dragged = true
        return pendingMouseDown
    }

    mutating func takeForStop() -> SuppressedMouseDown? {
        takeMouseUp()
    }
}

final class PendingReplayState {
    private let lock = NSLock()
    private var mouseGestures = 0
    private var events = 0

    func beginMouseGesture() {
        lock.lock()
        mouseGestures += 1
        events += 1
        lock.unlock()
    }

    func enqueueMouseEvent() {
        lock.lock()
        events += 1
        lock.unlock()
    }

    func endMouseGesture() {
        lock.lock()
        if mouseGestures > 0 { mouseGestures -= 1 }
        events += 1
        lock.unlock()
    }

    func enqueueKeyEventIfPending() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard mouseGestures > 0 || events > 0 else { return false }
        events += 1
        return true
    }

    func completeEvent() {
        lock.lock()
        if events > 0 { events -= 1 }
        lock.unlock()
    }

    var isPending: Bool {
        lock.lock()
        defer { lock.unlock() }
        return mouseGestures > 0 || events > 0
    }
}

struct ReplayMarker {
    // Replayed input must pass every recorder without being captured again.
    // The shared "SCH" prefix identifies Schaffa events across helper
    // processes; the random suffix lets only the originating helper complete
    // its own pending-event counter.
    static let magic: Int64 = 0x5343480000000000
    static let magicMask = Int64(bitPattern: 0xFFFFFF0000000000)
    static let instanceMask: Int64 = 0x000000FFFFFFFFFF
    static let legacy: Int64 = 0x0053434841464641

    static func make(instanceID: Int64? = nil) -> Int64 {
        let suffix = instanceID ?? Int64.random(in: 1...instanceMask)
        precondition(suffix > 0 && suffix <= instanceMask)
        return magic | suffix
    }

    static func isSchaffa(_ marker: Int64) -> Bool {
        marker == legacy || (marker & magicMask) == magic
    }
}
// STATE_HARNESS_END

final class DesktopRecorder {
    private struct CapturedClick {
        let payload: [String: Any]
        let screenshotPath: String?
    }

    private let outputDirectory: URL
    private let allowedBundleID: String
    private let requestedWindowID: CGWindowID?
    private let windowTitleToken: String?
    private let replayMarker: Int64
    private let replaySource: CGEventSource
    private let systemWide = AXUIElementCreateSystemWide()
    private let captureQueue = DispatchQueue(label: "dev.schaffa.desktop-recorder.capture")
    private let scopeStartedAt = Date()
    private var mouseState = MouseSuppressionState()
    private let pendingReplay = PendingReplayState()
    private var replayGestureID: UUID?
    private var capturedClick: CapturedClick?
    private var suppressPauseHotkeyUp = false
    private var eventTap: CFMachPort?
    private var signalSources: [DispatchSourceSignal] = []
    private var scopeTimer: Timer?
    private var scopedWindowID: CGWindowID?
    private var scopedOwnerPID: pid_t?
    private var scopedWindowElement: AXUIElement?
    private var scopeWasBound = false
    private var missingScopeChecks = 0
    private var stopping = false
    private var exitStatus: Int32 = 0

    init(
        outputDirectory: URL,
        allowedBundleID: String,
        requestedWindowID: CGWindowID? = nil,
        windowTitleToken: String? = nil
    ) {
        self.outputDirectory = outputDirectory
        self.allowedBundleID = allowedBundleID
        self.requestedWindowID = requestedWindowID
        self.windowTitleToken = windowTitleToken
        self.scopedWindowID = requestedWindowID
        replayMarker = ReplayMarker.make()
        replaySource = CGEventSource(stateID: .privateState)!
        replaySource.userData = replayMarker
        AXUIElementSetMessagingTimeout(systemWide, 0.2)
    }

    func run() -> Never {
        let mask = (CGEventMask(1) << CGEventType.leftMouseDown.rawValue)
            | (CGEventMask(1) << CGEventType.leftMouseDragged.rawValue)
            | (CGEventMask(1) << CGEventType.leftMouseUp.rawValue)
            | (CGEventMask(1) << CGEventType.keyDown.rawValue)
            | (CGEventMask(1) << CGEventType.keyUp.rawValue)
        let retained = Unmanaged.passUnretained(self).toOpaque()
        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .defaultTap,
            eventsOfInterest: mask,
            callback: { proxy, type, event, refcon in
                guard let refcon else { return Unmanaged.passUnretained(event) }
                return Unmanaged<DesktopRecorder>.fromOpaque(refcon)
                    .takeUnretainedValue()
                    .handle(proxy: proxy, type: type, event: event)
            },
            userInfo: retained
        ) else {
            emit(["type": "error", "code": "event_tap", "message": "The global click monitor could not be started. Grant Accessibility permission and try again."])
            exit(3)
        }
        eventTap = tap
        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        installSignalHandlers()
        emit(["type": "ready"])
        if requestedWindowID != nil || windowTitleToken != nil {
            let timer = Timer(timeInterval: 0.25, repeats: true) { [weak self] _ in
                self?.updateWindowScope()
            }
            scopeTimer = timer
            RunLoop.current.add(timer, forMode: .common)
            updateWindowScope()
        }
        CFRunLoopRun()
        captureQueue.sync {}
        exit(exitStatus)
    }

    private func handle(proxy: CGEventTapProxy, type: CGEventType, event: CGEvent) -> Unmanaged<CGEvent>? {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let eventTap { CGEvent.tapEnable(tap: eventTap, enable: true) }
            return Unmanaged.passUnretained(event)
        }
        let sourceMarker = event.getIntegerValueField(.eventSourceUserData)
        if ReplayMarker.isSchaffa(sourceMarker) {
            if sourceMarker == replayMarker {
                pendingReplay.completeEvent()
            }
            return Unmanaged.passUnretained(event)
        }
        if type == .keyDown,
           event.getIntegerValueField(.keyboardEventKeycode) == 15,
           event.flags.contains(.maskAlternate),
           event.flags.contains(.maskShift) {
            suppressPauseHotkeyUp = true
            emit(["type": "paused", "paused": mouseState.togglePause()])
            return nil
        }
        if type == .keyUp,
           event.getIntegerValueField(.keyboardEventKeycode) == 15,
           suppressPauseHotkeyUp {
            suppressPauseHotkeyUp = false
            return nil
        }
        if type == .keyDown || type == .keyUp {
            guard pendingReplay.enqueueKeyEventIfPending() else {
                return Unmanaged.passUnretained(event)
            }
            guard let replay = event.copy() else {
                pendingReplay.completeEvent()
                return nil
            }
            queueKeyReplay(replay)
            return nil
        }
        if type == .leftMouseDown {
            let scopeReady = (requestedWindowID == nil && windowTitleToken == nil) || scopeWasBound
            let targetWindow: WindowInfo?
            if mouseState.acceptsMouseDown && scopeReady {
                targetWindow = window(
                    at: event.location,
                    matching: allowedBundleID,
                    windowID: scopedWindowID,
                    ownerPID: scopedOwnerPID
                )
            } else {
                targetWindow = nil
            }

            // A capture can delay the recorded down event. While its replay is
            // pending, queue unrelated clicks behind it instead of allowing
            // them to overtake it. These replay-only gestures never emit a
            // guide step.
            guard mouseState.shouldSuppressMouseDown(
                recordsGuideStep: targetWindow != nil,
                replayPending: pendingReplay.isPending
            ) else {
                return Unmanaged.passUnretained(event)
            }
            guard let replay = event.copy() else { return Unmanaged.passUnretained(event) }
            let pending = SuppressedMouseDown(
                windowID: targetWindow?.id ?? 0,
                ownerPID: targetWindow?.ownerPID ?? 0,
                point: event.location,
                recordsGuideStep: targetWindow != nil
            )
            if let previous = mouseState.begin(pending) {
                queueSyntheticMouseUp(for: previous)
            }
            queueReplay(replay, type: type, gesture: pending)
            return nil
        } else if type == .leftMouseDragged {
            guard let pending = mouseState.markDragged() else {
                return Unmanaged.passUnretained(event)
            }
            // Once the down was suppressed, every event in the gesture must be
            // suppressed and replayed in order. Passing a drag through here can
            // deliver it before the queued down has reached the application.
            guard let replay = event.copy() else { return nil }
            queueReplay(replay, type: type, gesture: pending)
            return nil
        } else if type == .leftMouseUp {
            guard let pending = mouseState.takeMouseUp() else {
                return Unmanaged.passUnretained(event)
            }
            guard let replay = event.copy() else {
                queueSyntheticMouseUp(for: pending)
                return nil
            }
            queueReplay(replay, type: type, gesture: pending)
            return nil
        } else {
            return Unmanaged.passUnretained(event)
        }
    }

    private func queueReplay(
        _ replay: CGEvent,
        type: CGEventType,
        gesture: SuppressedMouseDown
    ) {
        if type == .leftMouseDown {
            pendingReplay.beginMouseGesture()
        } else if type == .leftMouseUp {
            pendingReplay.endMouseGesture()
        } else {
            pendingReplay.enqueueMouseEvent()
        }
        captureQueue.async { [self] in
            if type == .leftMouseDown {
                replayGestureID = gesture.gestureID
                capturedClick = nil
                if gesture.recordsGuideStep,
                   let captured = captureClick(
                    at: gesture.point,
                    matching: allowedBundleID,
                    windowID: gesture.windowID,
                    ownerPID: gesture.ownerPID
                ) {
                    if window(
                        at: gesture.point,
                        matching: allowedBundleID,
                        windowID: gesture.windowID,
                        ownerPID: gesture.ownerPID
                    ) != nil {
                        capturedClick = captured
                    } else {
                        discard(captured)
                    }
                }
            } else if type == .leftMouseDragged {
                guard replayGestureID == gesture.gestureID else {
                    pendingReplay.completeEvent()
                    return
                }
                if let capturedClick {
                    discard(capturedClick)
                    self.capturedClick = nil
                }
            } else if type == .leftMouseUp {
                guard replayGestureID == gesture.gestureID else {
                    pendingReplay.completeEvent()
                    return
                }
                if let capturedClick {
                    if gesture.dragged {
                        discard(capturedClick)
                    } else {
                        emit(capturedClick.payload)
                    }
                    self.capturedClick = nil
                }
                replayGestureID = nil
            } else {
                pendingReplay.completeEvent()
                return
            }
            replay.setSource(replaySource)
            // Chrome does not reliably dispatch PID-targeted mouse events to its
            // web contents. The exact topmost window was revalidated above;
            // posting through HID preserves normal click semantics.
            replay.post(tap: .cghidEventTap)
        }
    }

    private func queueKeyReplay(_ replay: CGEvent) {
        captureQueue.async {
            replay.setSource(self.replaySource)
            replay.post(tap: .cghidEventTap)
        }
    }

    private func queueSyntheticMouseUp(for pending: SuppressedMouseDown) {
        pendingReplay.endMouseGesture()
        captureQueue.async { [self] in
            guard replayGestureID == pending.gestureID else {
                pendingReplay.completeEvent()
                return
            }
            replayGestureID = nil
            if let capturedClick {
                discard(capturedClick)
                self.capturedClick = nil
            }
            guard let replay = CGEvent(
                mouseEventSource: nil,
                mouseType: .leftMouseUp,
                mouseCursorPosition: pending.point,
                mouseButton: .left
            ) else {
                pendingReplay.completeEvent()
                return
            }
            replay.setSource(replaySource)
            replay.post(tap: .cghidEventTap)
        }
    }

    private func captureClick(
        at point: CGPoint,
        matching bundleID: String,
        windowID: CGWindowID?,
        ownerPID: pid_t?
    ) -> CapturedClick? {
        guard let window = window(
            at: point,
            matching: bundleID,
            windowID: windowID,
            ownerPID: ownerPID
        ) else { return nil }
        let element = element(at: point)
        let role = stringAttribute(element, kAXRoleAttribute) ?? ""
        let subrole = stringAttribute(element, kAXSubroleAttribute) ?? ""
        let label = firstText([
            stringAttribute(element, kAXTitleAttribute),
            stringAttribute(element, kAXDescriptionAttribute),
            stringAttribute(element, kAXHelpAttribute),
            stringAttribute(element, kAXIdentifierAttribute),
        ])
        let sensitiveText = "\(role) \(subrole) \(label)".lowercased()
        let sensitive = sensitiveText.contains("secure")
            || sensitiveText.contains("password")
            || sensitiveText.contains("passwort")
            || sensitiveText.contains("credit card")
            || sensitiveText.contains("kreditkarte")

        var screenshotPath: String? = nil
        if !sensitive {
            screenshotPath = capture(window: window)
        }

        guard self.window(
            at: point,
            matching: bundleID,
            windowID: windowID,
            ownerPID: ownerPID
        ) != nil else {
            if let screenshotPath {
                try? FileManager.default.removeItem(atPath: screenshotPath)
            }
            return nil
        }

        let app = NSRunningApplication(processIdentifier: window.ownerPID)
        let bundleID = app?.bundleIdentifier ?? ""
        let relativeX = point.x - window.bounds.origin.x
        let relativeY = point.y - window.bounds.origin.y
        var payload: [String: Any] = [
            "type": "click",
            "timestamp": ISO8601DateFormatter().string(from: Date()),
            "app": window.ownerName,
            "bundleId": bundleID,
            "windowTitle": window.title,
            "windowId": Int(window.id),
            "role": role,
            "subrole": subrole,
            "label": label,
            "x": relativeX,
            "y": relativeY,
            "windowWidth": window.bounds.width,
            "windowHeight": window.bounds.height,
            "sensitive": sensitive,
        ]
        if let screenshotPath { payload["screenshotPath"] = screenshotPath }
        if let target = elementBounds(element), target.width > 0, target.height > 0 {
            payload["box"] = [
                "left": target.origin.x - window.bounds.origin.x,
                "top": target.origin.y - window.bounds.origin.y,
                "width": target.width,
                "height": target.height,
            ]
        }
        return CapturedClick(payload: payload, screenshotPath: screenshotPath)
    }

    private func discard(_ click: CapturedClick) {
        if let screenshotPath = click.screenshotPath {
            try? FileManager.default.removeItem(atPath: screenshotPath)
        }
    }

    private func updateWindowScope() {
        if let scopedWindowID {
            if let window = window(withID: scopedWindowID, matching: allowedBundleID),
               scopedOwnerPID == nil || scopedOwnerPID == window.ownerPID {
                if !scopeWasBound {
                    guard window.isOnScreen || accessibilityWindow(matching: window) != nil else {
                        checkScopeTimeout()
                        return
                    }
                    scopeWasBound = true
                    scopedOwnerPID = window.ownerPID
                    scopedWindowElement = accessibilityWindow(matching: window)
                    emit([
                        "type": "bound",
                        "windowId": Int(window.id),
                        "ownerPid": Int(window.ownerPID),
                        "windowTitle": window.title,
                    ])
                }
                if scopedWindowIsAvailable(window) {
                    missingScopeChecks = 0
                    return
                }
            }
            if scopeWasBound {
                missingScopeChecks += 1
                if missingScopeChecks >= 3 {
                    stop(status: 0)
                }
                return
            }
        } else if let token = windowTitleToken,
                  let window = windows(matching: allowedBundleID, onScreenOnly: false)
                    .first(where: {
                        $0.title.contains(token)
                            && ($0.isOnScreen || accessibilityWindow(matching: $0) != nil)
                    }) {
            scopedWindowID = window.id
            scopedOwnerPID = window.ownerPID
            scopedWindowElement = accessibilityWindow(matching: window)
            scopeWasBound = true
            emit([
                "type": "bound",
                "windowId": Int(window.id),
                "ownerPid": Int(window.ownerPID),
                "windowTitle": window.title,
            ])
            return
        }

        checkScopeTimeout()
    }

    private func checkScopeTimeout() {
        if !scopeWasBound && Date().timeIntervalSince(scopeStartedAt) >= 15 {
            emit([
                "type": "error",
                "code": "window_scope",
                "message": "The requested application window could not be found.",
            ])
            stop(status: 4)
        }
    }

    private func scopedWindowIsAvailable(_ window: WindowInfo) -> Bool {
        if window.isOnScreen { return true }
        guard let candidates = accessibilityWindows(ownerPID: window.ownerPID) else {
            // Keep the scope while Accessibility is temporarily unresponsive. The
            // CoreGraphics window still exists and a later check can decide.
            return true
        }
        if let scopedWindowElement,
           candidates.contains(where: {
               CFEqual($0, scopedWindowElement)
           }) {
            return true
        }
        if let element = accessibilityWindow(matching: window, among: candidates) {
            scopedWindowElement = element
            return true
        }
        return false
    }

    private func accessibilityWindow(matching window: WindowInfo) -> AXUIElement? {
        guard let candidates = accessibilityWindows(ownerPID: window.ownerPID) else { return nil }
        return accessibilityWindow(matching: window, among: candidates)
    }

    private func accessibilityWindow(
        matching window: WindowInfo,
        among candidates: [AXUIElement]
    ) -> AXUIElement? {
        let titleMatches = candidates.filter {
            stringAttribute($0, kAXTitleAttribute) == window.title
        }
        if titleMatches.count == 1 { return titleMatches[0] }
        return candidates.first {
            guard let bounds = elementBounds($0) else { return false }
            return abs(bounds.origin.x - window.bounds.origin.x) <= 2
                && abs(bounds.origin.y - window.bounds.origin.y) <= 2
                && abs(bounds.width - window.bounds.width) <= 2
                && abs(bounds.height - window.bounds.height) <= 2
        }
    }

    private func accessibilityWindows(ownerPID: pid_t) -> [AXUIElement]? {
        let application = AXUIElementCreateApplication(ownerPID)
        AXUIElementSetMessagingTimeout(application, 0.2)
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            application,
            kAXWindowsAttribute as CFString,
            &raw
        ) == .success else { return nil }
        return raw as? [AXUIElement] ?? []
    }

    private func installSignalHandlers() {
        for signalNumber in [SIGINT, SIGTERM] {
            signal(signalNumber, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
            source.setEventHandler { [weak self] in
                self?.stop(status: 0)
            }
            source.resume()
            signalSources.append(source)
        }
    }

    private func stop(status: Int32) {
        guard !stopping else { return }
        stopping = true
        if let pending = mouseState.takeForStop() {
            queueSyntheticMouseUp(for: pending)
        }
        scopeTimer?.invalidate()
        scopeTimer = nil
        exitStatus = status
        CFRunLoopStop(CFRunLoopGetCurrent())
    }

    private func window(
        at point: CGPoint,
        matching bundleID: String,
        windowID: CGWindowID?,
        ownerPID: pid_t?
    ) -> WindowInfo? {
        guard let hitOwnerPID = accessibilityOwnerPID(at: point),
              ownerPID == nil || hitOwnerPID == ownerPID,
              NSRunningApplication(processIdentifier: hitOwnerPID)?.bundleIdentifier == bundleID else {
            return nil
        }
        guard let raw = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
            return nil
        }
        for item in raw {
            // CGWindowListCopyWindowInfo is ordered front to back. The first
            // window belonging to the Accessibility hit target owns the click.
            // Filtering by that PID skips Window Server's transparent, full-
            // screen system layers while still stopping at real menus, HUDs,
            // and popovers above the scoped layer-zero window.
            guard visibleWindow(item, ownedBy: hitOwnerPID, contains: point) else { continue }
            guard let window = parseWindow(item) else { return nil }
            guard NSRunningApplication(processIdentifier: window.ownerPID)?.bundleIdentifier == bundleID,
                  windowID == nil || window.id == windowID,
                  ownerPID == nil || window.ownerPID == ownerPID else { return nil }
            return window
        }
        return nil
    }

    private func accessibilityOwnerPID(at point: CGPoint) -> pid_t? {
        guard let element = element(at: point) else { return nil }
        var ownerPID: pid_t = 0
        guard AXUIElementGetPid(element, &ownerPID) == .success else { return nil }
        return ownerPID
    }

    private func visibleWindow(
        _ item: [String: Any],
        ownedBy ownerPID: pid_t,
        contains point: CGPoint
    ) -> Bool {
        guard let boundsDictionary = item[kCGWindowBounds as String] as? [String: Any],
              let bounds = CGRect(dictionaryRepresentation: boundsDictionary as CFDictionary),
              bounds.contains(point),
              let rawOwnerPID = item[kCGWindowOwnerPID as String] as? NSNumber,
              pid_t(rawOwnerPID.int32Value) == ownerPID else { return false }
        let alpha = (item[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1
        return alpha > 0
    }

    private func window(withID windowID: CGWindowID, matching bundleID: String) -> WindowInfo? {
        guard let raw = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]],
              let window = raw.lazy.compactMap({ self.parseWindow($0) }).first(where: { $0.id == windowID }),
              NSRunningApplication(processIdentifier: window.ownerPID)?.bundleIdentifier == bundleID else {
            return nil
        }
        return window
    }

    private func windows(matching bundleID: String, onScreenOnly: Bool) -> [WindowInfo] {
        let options: CGWindowListOption = onScreenOnly
            ? [.optionOnScreenOnly, .excludeDesktopElements]
            : [.optionAll, .excludeDesktopElements]
        guard let raw = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
            return []
        }
        return raw.compactMap { item in
            guard let window = parseWindow(item),
                  NSRunningApplication(processIdentifier: window.ownerPID)?.bundleIdentifier == bundleID else {
                return nil
            }
            return window
        }
    }

    private func parseWindow(_ item: [String: Any]) -> WindowInfo? {
        guard let layer = item[kCGWindowLayer as String] as? NSNumber,
              layer.intValue == 0,
              let number = item[kCGWindowNumber as String] as? NSNumber,
              let boundsDictionary = item[kCGWindowBounds as String] as? [String: Any],
              let bounds = CGRect(dictionaryRepresentation: boundsDictionary as CFDictionary),
              let ownerPID = item[kCGWindowOwnerPID as String] as? NSNumber else { return nil }
        let alpha = (item[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1
        guard alpha > 0 else { return nil }
        return WindowInfo(
            id: CGWindowID(number.uint32Value),
            bounds: bounds,
            ownerName: item[kCGWindowOwnerName as String] as? String ?? "Application",
            ownerPID: pid_t(ownerPID.int32Value),
            title: item[kCGWindowName as String] as? String ?? "",
            isOnScreen: (item[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? false
        )
    }

    private func element(at point: CGPoint) -> AXUIElement? {
        var element: AXUIElement?
        let error = AXUIElementCopyElementAtPosition(systemWide, Float(point.x), Float(point.y), &element)
        return error == .success ? element : nil
    }

    private func stringAttribute(_ element: AXUIElement?, _ attribute: String) -> String? {
        guard let element else { return nil }
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &raw) == .success else { return nil }
        return raw as? String
    }

    private func elementBounds(_ element: AXUIElement?) -> CGRect? {
        guard let element else { return nil }
        var rawPosition: CFTypeRef?
        var rawSize: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &rawPosition) == .success,
              AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &rawSize) == .success,
              let rawPosition,
              let rawSize,
              CFGetTypeID(rawPosition) == AXValueGetTypeID(),
              CFGetTypeID(rawSize) == AXValueGetTypeID() else { return nil }
        let positionValue = unsafeBitCast(rawPosition, to: AXValue.self)
        let sizeValue = unsafeBitCast(rawSize, to: AXValue.self)
        var position = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(positionValue, .cgPoint, &position),
              AXValueGetValue(sizeValue, .cgSize, &size) else { return nil }
        return CGRect(origin: position, size: size)
    }

    private func capture(window: WindowInfo) -> String? {
        let destination = outputDirectory.appendingPathComponent("desktop-\(UUID().uuidString).png")
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        process.arguments = ["-x", "-o", "-l", String(window.id), destination.path]
        do {
            try process.run()
            process.waitUntilExit()
            guard process.terminationStatus == 0,
                  FileManager.default.fileExists(atPath: destination.path) else { return nil }
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: destination.path)
            return destination.path
        } catch {
            try? FileManager.default.removeItem(at: destination)
            return nil
        }
    }
}

func firstText(_ values: [String?]) -> String {
    for value in values {
        let normalized = (value ?? "").replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines)
        if !normalized.isEmpty { return String(normalized.prefix(200)) }
    }
    return ""
}

let emitLock = NSLock()

func emit(_ payload: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(payload),
          let data = try? JSONSerialization.data(withJSONObject: payload),
          var line = String(data: data, encoding: .utf8) else { return }
    line.append("\n")
    emitLock.lock()
    defer { emitLock.unlock() }
    FileHandle.standardOutput.write(Data(line.utf8))
}

func permissions(prompt: Bool) -> (Bool, [String]) {
    var missing: [String] = []
    let accessibility: Bool
    if prompt {
        accessibility = AXIsProcessTrustedWithOptions([
            kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true,
        ] as CFDictionary)
    } else {
        accessibility = AXIsProcessTrusted()
    }
    if !accessibility { missing.append("Accessibility") }
    if #available(macOS 10.15, *) {
        var screen = CGPreflightScreenCaptureAccess()
        if prompt && !screen { screen = CGRequestScreenCaptureAccess() }
        if !screen { missing.append("Screen Recording") }
    }
    return (missing.isEmpty, missing)
}

let arguments = CommandLine.arguments
let checking = arguments.contains("--check")
let (allowed, missing) = permissions(prompt: checking)
if checking {
    emit(["type": "permissions", "allowed": allowed, "missing": missing])
    exit(allowed ? 0 : 2)
}
guard allowed else {
    emit(["type": "error", "code": "permissions", "message": "Missing macOS permissions: \(missing.joined(separator: ", ")). Run the recorder again to grant them."])
    exit(2)
}
guard let outputIndex = arguments.firstIndex(of: "--output"), outputIndex + 1 < arguments.count else {
    emit(["type": "error", "code": "arguments", "message": "Missing --output directory."])
    exit(64)
}
guard let bundleIndex = arguments.firstIndex(of: "--bundle-id"), bundleIndex + 1 < arguments.count else {
    emit(["type": "error", "code": "arguments", "message": "Missing --bundle-id application scope."])
    exit(64)
}
let windowID: CGWindowID?
if let windowIndex = arguments.firstIndex(of: "--window-id") {
    guard windowIndex + 1 < arguments.count,
          !arguments[windowIndex + 1].hasPrefix("--") else {
        emit(["type": "error", "code": "arguments", "message": "Missing --window-id value."])
        exit(64)
    }
    guard let parsed = UInt32(arguments[windowIndex + 1]) else {
        emit(["type": "error", "code": "arguments", "message": "Invalid --window-id value."])
        exit(64)
    }
    windowID = CGWindowID(parsed)
} else {
    windowID = nil
}
let windowTitleToken: String?
if let tokenIndex = arguments.firstIndex(of: "--window-title-token") {
    guard tokenIndex + 1 < arguments.count,
          !arguments[tokenIndex + 1].hasPrefix("--") else {
        emit(["type": "error", "code": "arguments", "message": "Missing --window-title-token value."])
        exit(64)
    }
    let token = arguments[tokenIndex + 1]
    guard !token.isEmpty else {
        emit(["type": "error", "code": "arguments", "message": "Invalid --window-title-token value."])
        exit(64)
    }
    windowTitleToken = token
} else {
    windowTitleToken = nil
}
if windowID != nil && windowTitleToken != nil {
    emit(["type": "error", "code": "arguments", "message": "Choose --window-id or --window-title-token, not both."])
    exit(64)
}
let outputDirectory = URL(fileURLWithPath: arguments[outputIndex + 1], isDirectory: true)
do {
    try FileManager.default.createDirectory(
        at: outputDirectory,
        withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700]
    )
} catch {
    emit([
        "type": "error",
        "code": "output",
        "message": "The output directory could not be created: \(error.localizedDescription)",
    ])
    exit(73)
}
DesktopRecorder(
    outputDirectory: outputDirectory,
    allowedBundleID: arguments[bundleIndex + 1],
    requestedWindowID: windowID,
    windowTitleToken: windowTitleToken
).run()
