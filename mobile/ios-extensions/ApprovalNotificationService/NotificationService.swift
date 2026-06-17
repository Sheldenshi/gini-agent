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

class NotificationService: UNNotificationServiceExtension {
    var contentHandler: ((UNNotificationContent) -> Void)?
    var bestAttemptContent: UNMutableNotificationContent?
    var fetchTask: URLSessionDataTask?

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
            contentHandler(request.content)
            return
        }

        // Routing fields are nested under `body` in the push payload.
        let routing = bestAttempt.userInfo["body"] as? [String: Any]
        let event = routing?["event"] as? String

        // Attach the approval category up front so the action buttons show
        // even if the enrichment fetch never completes.
        if let event = event, Self.approvalEvents.contains(event) {
            bestAttempt.categoryIdentifier = Self.approvalCategoryId
        }

        // Only the alert events have a preview to fetch. Anything else (or
        // a malformed payload) falls through to the as-sent banner.
        guard
            let event = event,
            Self.enrichableEvents.contains(event),
            let sessionId = routing?["sessionId"] as? String,
            let creds = Self.loadSharedCredentials(),
            let url = Self.previewURL(
                baseUrl: creds.baseUrl,
                event: event,
                sessionId: sessionId,
                approvalId: routing?["approvalId"] as? String
            )
        else {
            contentHandler(bestAttempt)
            return
        }

        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = "GET"
        urlRequest.timeoutInterval = Self.fetchTimeoutSeconds
        urlRequest.setValue("Bearer \(creds.token)", forHTTPHeaderField: "Authorization")
        if let deviceToken = creds.deviceToken, !deviceToken.isEmpty {
            urlRequest.setValue(deviceToken, forHTTPHeaderField: "X-Device-Token")
        }

        fetchTask = URLSession.shared.dataTask(with: urlRequest) { [weak self] data, response, _ in
            guard let self = self,
                  let bestAttempt = self.bestAttemptContent,
                  let handler = self.contentHandler else { return }

            if let http = response as? HTTPURLResponse,
               http.statusCode == 200,
               let data = data,
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let title = json["title"] as? String,
               let body = json["body"] as? String,
               !body.isEmpty {
                bestAttempt.title = title
                bestAttempt.body = body
            }
            // On any non-200 / parse failure we leave the generic content
            // in place — the user still gets the banner.
            handler(bestAttempt)
        }
        fetchTask?.resume()
    }

    override func serviceExtensionTimeWillExpire() {
        // iOS calls this if the 30s window expires before we returned.
        // Cancel the in-flight fetch and hand back whatever we have — the
        // generic banner beats no banner.
        fetchTask?.cancel()
        if let contentHandler = contentHandler, let bestAttempt = bestAttemptContent {
            contentHandler(bestAttempt)
        }
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
            return nil
        }
        let fileURL = containerURL.appendingPathComponent(credentialsFilename)
        guard let data = try? Data(contentsOf: fileURL),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let baseUrl = json["baseUrl"] as? String,
              let token = json["token"] as? String else {
            return nil
        }
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
    static func previewURL(
        baseUrl: String,
        event: String,
        sessionId: String,
        approvalId: String?
    ) -> URL? {
        guard var components = URLComponents(string: baseUrl) else { return nil }
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
}
