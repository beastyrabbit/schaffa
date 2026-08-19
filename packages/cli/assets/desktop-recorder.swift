import AppKit
import ApplicationServices
import Foundation

struct WindowInfo {
    let id: CGWindowID
    let bounds: CGRect
    let ownerName: String
    let ownerPID: pid_t
    let title: String
}

final class DesktopRecorder {
    private static let replayMarker: Int64 = 0x53434841464641
    private let outputDirectory: URL
    private let allowedBundleID: String
    private let systemWide = AXUIElementCreateSystemWide()
    private let captureQueue = DispatchQueue(label: "dev.schaffa.desktop-recorder.capture")
    private var paused = false
    private var pendingMouseUp = false
    private var eventTap: CFMachPort?

    init(outputDirectory: URL, allowedBundleID: String) {
        self.outputDirectory = outputDirectory
        self.allowedBundleID = allowedBundleID
        AXUIElementSetMessagingTimeout(systemWide, 0.2)
    }

    func run() -> Never {
        let mask = (CGEventMask(1) << CGEventType.leftMouseDown.rawValue)
            | (CGEventMask(1) << CGEventType.leftMouseUp.rawValue)
            | (CGEventMask(1) << CGEventType.keyDown.rawValue)
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
        emit(["type": "ready"])
        CFRunLoopRun()
        exit(0)
    }

    private func handle(proxy: CGEventTapProxy, type: CGEventType, event: CGEvent) -> Unmanaged<CGEvent>? {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let eventTap { CGEvent.tapEnable(tap: eventTap, enable: true) }
            return Unmanaged.passUnretained(event)
        }
        if event.getIntegerValueField(.eventSourceUserData) == Self.replayMarker {
            return Unmanaged.passUnretained(event)
        }
        if type == .keyDown,
           event.getIntegerValueField(.keyboardEventKeycode) == 15,
           event.flags.contains(.maskAlternate),
           event.flags.contains(.maskShift) {
            paused.toggle()
            emit(["type": "paused", "paused": paused])
            return nil
        }
        guard !paused else {
            return Unmanaged.passUnretained(event)
        }
        if type == .leftMouseDown {
            guard window(at: event.location, matching: allowedBundleID) != nil else {
                return Unmanaged.passUnretained(event)
            }
            pendingMouseUp = true
        } else if type == .leftMouseUp {
            guard pendingMouseUp else { return Unmanaged.passUnretained(event) }
            pendingMouseUp = false
        } else {
            return Unmanaged.passUnretained(event)
        }
        guard let replay = event.copy() else { return Unmanaged.passUnretained(event) }
        let point = event.location
        captureQueue.async { [self] in
            if type == .leftMouseDown { captureClick(at: point, matching: allowedBundleID) }
            replay.setIntegerValueField(.eventSourceUserData, value: Self.replayMarker)
            replay.post(tap: .cghidEventTap)
        }
        return nil
    }

    private func captureClick(at point: CGPoint, matching bundleID: String) {
        guard let window = window(at: point, matching: bundleID) else { return }
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
        emit(payload)
    }

    private func window(at point: CGPoint, matching bundleID: String) -> WindowInfo? {
        guard let raw = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
            return nil
        }
        for item in raw {
            guard let layer = item[kCGWindowLayer as String] as? NSNumber,
                  layer.intValue == 0,
                  let number = item[kCGWindowNumber as String] as? NSNumber,
                  let boundsDictionary = item[kCGWindowBounds as String] as? [String: Any],
                  let bounds = CGRect(dictionaryRepresentation: boundsDictionary as CFDictionary),
                  bounds.contains(point),
                  let ownerPID = item[kCGWindowOwnerPID as String] as? NSNumber else { continue }
            let alpha = (item[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1
            if alpha <= 0 { continue }
            let pid = pid_t(ownerPID.int32Value)
            guard NSRunningApplication(processIdentifier: pid)?.bundleIdentifier == bundleID else {
                return nil
            }
            return WindowInfo(
                id: CGWindowID(number.uint32Value),
                bounds: bounds,
                ownerName: item[kCGWindowOwnerName as String] as? String ?? "Application",
                ownerPID: pid,
                title: item[kCGWindowName as String] as? String ?? ""
            )
        }
        return nil
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

func emit(_ payload: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(payload),
          let data = try? JSONSerialization.data(withJSONObject: payload),
          var line = String(data: data, encoding: .utf8) else { return }
    line.append("\n")
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
let outputDirectory = URL(fileURLWithPath: arguments[outputIndex + 1], isDirectory: true)
try FileManager.default.createDirectory(at: outputDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
DesktopRecorder(outputDirectory: outputDirectory, allowedBundleID: arguments[bundleIndex + 1]).run()
