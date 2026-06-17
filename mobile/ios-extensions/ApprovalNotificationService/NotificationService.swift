// Notification Service Extension for the Gini iOS app.
//
// Triggered by APNs payloads with `mutable-content: 1` so the OS gives us
// up to 30 seconds (Apple's documented ceiling for didReceive before
// serviceExtensionTimeWillExpire fires) to mutate the notification before
// display. The extension does two things:
//
//   1. Fetch-and-enrich. The APNs wire payload carries only routing ids
//      and a generic body ("Tap to read" / "Tap to review") — never chat
//      text, because Apple's servers see every byte of a push. Here, ON
//      DEVICE, we call the gateway's GET /api/push/preview with the
//      bearer the main app stashed in the shared App Group container,
//      receive the real title + body, and rewrite the banner. The message
//      text reaches the device over its own authenticated connection to
//      the gateway; it never transits Apple. See ADR
//      mobile-push-notifications.md.
//
//   2. Attach the approval category. For approval / setup events we set
//      categoryIdentifier = "APPROVAL_REQUEST" so the OS renders the
//      lock-screen Approve / Deny buttons the main app registered.
//
// Routing fields live under userInfo["body"] (the dispatcher nests them
// there because expo-notifications drops top-level userInfo keys on the
// client; the NSE forwards userInfo intact, so it reads the same shape).
//
// Fallback discipline: on ANY failure — no shared creds, network error,
// non-200, malformed JSON, or the 30s budget expiring — we hand back the
// original as-sent content. The user always sees a notification; worst
// case it's the generic "Tap to read" banner, exactly as before.

import UserNotifications
import os

// Subsystem/category for unified-logging diagnostics. Stream on a tethered
// device with:  log stream --predicate 'subsystem == "ai.lilaclabs.gini.nse"' --info
// or filter Console.app by the ApprovalNotificationService process. These
// lines make every NSE decision (invoked / creds / fetch status) visible;
// the NSE is otherwise silent and every fallback looks identical.
private let nseLog = Logger(subsystem: "ai.lilaclabs.gini.nse", category: "enrich")

class NotificationService: UNNotificationServiceExtension {
    var contentHandler: ((UNNotificationContent) -> Void)?
    var bestAttemptContent: UNMutableNotificationContent?
    var fetchTask: URLSessionDataTask?
    // Serializes deliver() so the content handler fires exactly once. The
    // URLSession completion (a background delegate queue) and
    // serviceExtensionTimeWillExpire() (the OS timeout thread) can both
    // reach deliver() concurrently — without a lock the check-then-clear
    // of contentHandler is a data race that can call the handler twice.
    private let deliverLock = NSLock()

    // Must match plugins/with-approval-notification-service.js (App Group
    // default `group.<hostBundleId>`) and src/shared-credentials.ts.
    static let appGroupId = "group.ai.lilaclabs.gini.mobile"
    static let credentialsFilename = "gini-push-creds.json"
    static let approvalCategoryId = "APPROVAL_REQUEST"
    // Events the gateway can build a rich preview for. The silent phase_*
    // wakes carry no alert, so the OS never invokes the NSE for them.
    static let enrichableEvents: Set<String> = [
        "message_completed", "authorization_requested", "setup_requested"
    ]
    // Events that surface the inline Approve / Deny action buttons. Only
    // authorization_requested — a setup request needs the app (open a
    // browser, fill a form), so it deep-links on tap rather than carrying
    // Approve/Deny. Must match the category the dispatcher attaches and the
    // main app registers (APPROVAL_REQUEST).
    static let approvalEvents: Set<String> = ["authorization_requested"]
    // Network budget for the on-device fetch. Held comfortably under
    // Apple's 30-second NSE ceiling so a slow gateway still leaves time to
    // call the content handler with best-attempt content.
    static let fetchTimeoutSeconds: TimeInterval = 20

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        self.contentHandler = contentHandler
        self.bestAttemptContent = request.content.mutableCopy() as? UNMutableNotificationContent

        guard let bestAttempt = bestAttemptContent else {
            // Couldn't get a mutable copy — surface the unchanged content.
            nseLog.error("no mutable copy of content; delivering as-sent")
            contentHandler(request.content)
            return
        }

        // Routing fields are nested under `body` in the push payload.
        let routing = bestAttempt.userInfo["body"] as? [String: Any]
        let event = routing?["event"] as? String
        nseLog.info("didReceive event=\(event ?? "nil", privacy: .public) hasBody=\(routing != nil, privacy: .public)")

        // Attach the approval category up front so the action buttons show
        // even if the enrichment fetch never completes.
        if let event = event, Self.approvalEvents.contains(event) {
            bestAttempt.categoryIdentifier = Self.approvalCategoryId
        }

        // Only the alert events have a preview to fetch. Anything else (or
        // a malformed payload) falls through to the as-sent banner. Each
        // precondition is checked separately so the log names the exact
        // reason enrichment was skipped.
        guard let event = event, Self.enrichableEvents.contains(event) else {
            nseLog.info("skip enrich: event not enrichable (\(event ?? "nil", privacy: .public))")
            deliver(bestAttempt)
            return
        }
        guard let sessionId = routing?["sessionId"] as? String else {
            nseLog.error("skip enrich: missing sessionId in payload body")
            deliver(bestAttempt)
            return
        }
        guard let creds = Self.loadSharedCredentials() else {
            nseLog.error("skip enrich: no shared credentials in App Group container")
            deliver(bestAttempt)
            return
        }
        guard let url = Self.previewURL(
            baseUrl: creds.baseUrl,
            event: event,
            sessionId: sessionId,
            approvalId: routing?["approvalId"] as? String
        ) else {
            nseLog.error("skip enrich: previewURL nil (baseUrl rejected by transport guard or unparseable)")
            deliver(bestAttempt)
            return
        }
        nseLog.info("fetching preview from \(url.host ?? "?", privacy: .public)\(url.path, privacy: .public)")

        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = "GET"
        urlRequest.timeoutInterval = Self.fetchTimeoutSeconds
        urlRequest.setValue("Bearer \(creds.token)", forHTTPHeaderField: "Authorization")
        if let deviceToken = creds.deviceToken, !deviceToken.isEmpty {
            urlRequest.setValue(deviceToken, forHTTPHeaderField: "X-Device-Token")
        }

        fetchTask = URLSession.shared.dataTask(with: urlRequest) { [weak self] data, response, error in
            guard let self = self, let bestAttempt = self.bestAttemptContent else { return }

            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            if let error = error {
                nseLog.error("preview fetch error: \(error.localizedDescription, privacy: .public)")
            }
            if status == 200,
               let data = data,
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let title = json["title"] as? String,
               let body = json["body"] as? String,
               !body.isEmpty {
                bestAttempt.title = title
                bestAttempt.body = body
                nseLog.info("enriched banner from preview (status=200)")
            } else {
                nseLog.error("enrich failed: status=\(status, privacy: .public) bytes=\(data?.count ?? 0, privacy: .public); keeping generic banner")
            }
            // On any non-200 / parse failure (including a cancellation
            // error from serviceExtensionTimeWillExpire) we leave the
            // generic content in place — the user still gets the banner.
            self.deliver(bestAttempt)
        }
        fetchTask?.resume()
    }

    override func serviceExtensionTimeWillExpire() {
        // iOS calls this if the 30s window expires before we returned.
        // Cancel the in-flight fetch and hand back whatever we have — the
        // generic banner beats no banner. cancel() still fires the task's
        // completion handler (with NSURLErrorCancelled), so deliver() must
        // be idempotent to avoid a double content-handler call.
        nseLog.error("serviceExtensionTimeWillExpire fired (30s budget hit) — delivering best-attempt")
        fetchTask?.cancel()
        if let bestAttempt = bestAttemptContent {
            deliver(bestAttempt)
        }
    }

    // Invoke the content handler exactly once. Apple requires a NSE to
    // call its content handler precisely one time; both the fetch
    // completion and the timeout path can race to call it (a cancelled
    // URLSession task still delivers its completion with an error). The
    // claim-under-lock makes the check-then-clear atomic so only the first
    // caller gets the handler; the handler itself is invoked OUTSIDE the
    // lock so it can never deadlock or hold the lock across UI work.
    private func deliver(_ content: UNNotificationContent) {
        deliverLock.lock()
        let handler = contentHandler
        contentHandler = nil
        deliverLock.unlock()
        if handler == nil {
            nseLog.error("deliver() called but handler already consumed (double-deliver suppressed)")
        } else {
            nseLog.info("deliver() handing content to OS")
        }
        handler?(content)
    }

    // Credentials the main app wrote into the shared App Group container.
    // Returns nil when the container is unavailable (entitlements not
    // signed in), the file is missing (user never signed in), or the JSON
    // is malformed — every case falls back to the as-sent banner.
    struct SharedCredentials {
        let baseUrl: String
        let token: String
        let deviceToken: String?
    }

    static func loadSharedCredentials() -> SharedCredentials? {
        guard let containerURL = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: appGroupId
        ) else {
            nseLog.error("creds: containerURL nil for app group \(appGroupId, privacy: .public) — entitlement not effective in this build")
            return nil
        }
        let fileURL = containerURL.appendingPathComponent(credentialsFilename)
        let exists = FileManager.default.fileExists(atPath: fileURL.path)
        nseLog.info("creds: container=\(containerURL.path, privacy: .public) fileExists=\(exists, privacy: .public)")
        guard let data = try? Data(contentsOf: fileURL) else {
            nseLog.error("creds: could not read \(self.credentialsFilename, privacy: .public) (app never wrote it, or no access)")
            return nil
        }
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let baseUrl = json["baseUrl"] as? String,
              let token = json["token"] as? String else {
            nseLog.error("creds: file present (\(data.count, privacy: .public) bytes) but JSON/baseUrl/token missing")
            return nil
        }
        nseLog.info("creds: loaded baseUrl host=\(URL(string: baseUrl)?.host ?? "?", privacy: .public) hasDeviceToken=\(json["deviceToken"] != nil, privacy: .public)")
        return SharedCredentials(
            baseUrl: baseUrl,
            token: token,
            deviceToken: json["deviceToken"] as? String
        )
    }

    // Compose the preview URL: <baseUrl>/api/push/preview?sessionId=…&event=…[&approvalId=…].
    // `baseUrl` is the normalized gateway origin (scheme://host[:port], no
    // path), so we set the path and let URLComponents percent-encode the
    // query values.
    //
    // Transport guard: we attach the gateway bearer to this request, and
    // the NSE has ATS disabled, so we mirror the JS side's
    // isLocalGatewayHost / assertTransportAllowed defense-in-depth — refuse
    // to build a URL (and therefore never send the bearer) for a public
    // http:// origin. https is always allowed; http only to a local host.
    // The app already normalizes baseUrl at write time, so this only fires
    // on a corrupt/stale/regressed shared-container value.
    static func previewURL(
        baseUrl: String,
        event: String,
        sessionId: String,
        approvalId: String?
    ) -> URL? {
        guard var components = URLComponents(string: baseUrl),
              let scheme = components.scheme?.lowercased(),
              scheme == "https" || (scheme == "http" && isLocalHost(components.host)) else {
            return nil
        }
        components.path = "/api/push/preview"
        var items = [
            URLQueryItem(name: "sessionId", value: sessionId),
            URLQueryItem(name: "event", value: event)
        ]
        if let approvalId = approvalId, !approvalId.isEmpty {
            items.append(URLQueryItem(name: "approvalId", value: approvalId))
        }
        components.queryItems = items
        return components.url
    }

    // True when `host` is on the user's own machine or a private network
    // they control — the set plaintext http:// is allowed to reach. Mirrors
    // mobile/src/auth.ts isLocalGatewayHost: loopback, *.local, RFC1918
    // (10/8, 172.16-31/12, 192.168/16), and CGNAT (100.64-127/10, Tailscale).
    static func isLocalHost(_ host: String?) -> Bool {
        guard let raw = host, !raw.isEmpty else { return false }
        // WHATWG/URLComponents may bracket IPv6 ("[::1]"); strip one pair.
        var h = raw.lowercased()
        if h.hasPrefix("[") && h.hasSuffix("]") { h = String(h.dropFirst().dropLast()) }
        if h == "localhost" || h == "127.0.0.1" || h == "::1" { return true }
        if h.hasSuffix(".local") { return true }
        let octets = h.split(separator: ".", omittingEmptySubsequences: false)
        guard octets.count == 4 else { return false }
        var parsed: [Int] = []
        for part in octets {
            guard !part.isEmpty, part.count <= 3, part.allSatisfy({ $0.isNumber }),
                  let n = Int(part), n >= 0, n <= 255 else { return false }
            parsed.append(n)
        }
        let a = parsed[0], b = parsed[1]
        if a == 10 { return true }
        if a == 172 && b >= 16 && b <= 31 { return true }
        if a == 192 && b == 168 { return true }
        if a == 100 && b >= 64 && b <= 127 { return true }
        return false
    }
}
