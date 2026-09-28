import SwiftUI
import WebKit
import CoreLocation
import UIKit
import Security

@main
struct MMPatriotsDispatchApp: App {
    @StateObject private var location = DriverLocationService()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(location)
        }
    }
}

struct ContentView: View {
    @EnvironmentObject private var location: DriverLocationService
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("dispatchServerURL") private var serverURL = ""
    @State private var enteredURL = ""
    @State private var error = ""

    private var configuredURL: URL? {
        guard let url = URL(string: serverURL),
              url.scheme == "https", url.host != nil, url.user == nil, url.password == nil,
              (url.path.isEmpty || url.path == "/"),
              url.query == nil, url.fragment == nil else { return nil }
        return url
    }

    var body: some View {
        Group {
        if let url = configuredURL {
            VStack(spacing: 0) {
                HStack {
                    Text("Dispatch").font(.headline)
                    Spacer()
                    Button("Change Server") {
                        location.checkOut()
                        serverURL = ""
                    }
                    .disabled(location.active)
                }
                .padding(10)
                if location.active || location.status.contains("pending") {
                    HStack {
                        Text(location.status).font(.caption)
                        Spacer()
                        if location.requiresSettings {
                            Button("Location Settings") {
                                if let url = URL(string: UIApplication.openSettingsURLString) {
                                    UIApplication.shared.open(url)
                                }
                            }.font(.caption)
                        }
                    }.padding(10)
                }
                WebContainer(baseURL: url, location: location)
            }
        } else {
            Form {
                Section("Dispatch server") {
                    TextField("https://your-app.example.com", text: $enteredURL)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                        .autocorrectionDisabled()
                    Button("Connect") {
                        let value = enteredURL.trimmingCharacters(in: .whitespacesAndNewlines)
                        guard let url = URL(string: value), url.scheme == "https",
                              url.host != nil, url.user == nil, url.password == nil, (url.path.isEmpty || url.path == "/"),
                              url.query == nil, url.fragment == nil else {
                            error = "Enter the HTTPS address of your Dispatch server."
                            return
                        }
                        error = ""
                        serverURL = url.absoluteString
                    }
                    if !error.isEmpty { Text(error).foregroundStyle(.red) }
                }
            }
            .onAppear { enteredURL = serverURL }
        }
        }
        .onChange(of: scenePhase) { phase in
            if phase == .active { location.refresh() }
        }
    }
}

struct WebContainer: UIViewRepresentable {
    let baseURL: URL
    let location: DriverLocationService

    func makeCoordinator() -> Coordinator { Coordinator(baseURL: baseURL, location: location) }

    func makeUIView(context: Context) -> WKWebView {
        let controller = WKUserContentController()
        controller.add(context.coordinator, name: "driverLocation")
        controller.addUserScript(WKUserScript(source: "window.nativeTripNotifications = true;", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = controller
        let webView = WKWebView(frame: .zero, configuration: configuration)
        context.coordinator.webView = webView
        location.webView = webView
        location.baseURL = baseURL
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.load(URLRequest(url: baseURL))
        return webView
    }

    func updateUIView(_ view: WKWebView, context: Context) {}

    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        view.configuration.userContentController.removeScriptMessageHandler(forName: "driverLocation")
    }

    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
        let baseURL: URL
        let location: DriverLocationService
        weak var webView: WKWebView?

        init(baseURL: URL, location: DriverLocationService) {
            self.baseURL = baseURL
            self.location = location
        }

        private func dialogPresenter(for webView: WKWebView) -> UIViewController? {
            guard var presenter = webView.window?.rootViewController else { return nil }
            while let presented = presenter.presentedViewController {
                presenter = presented
            }
            guard !presenter.isBeingDismissed, !(presenter is UIAlertController) else { return nil }
            return presenter
        }

        func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
            guard let presenter = dialogPresenter(for: webView) else {
                completionHandler(false)
                return
            }
            let dialog = UIAlertController(title: "Dispatch", message: message, preferredStyle: .alert)
            dialog.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
            dialog.addAction(UIAlertAction(title: "Confirm", style: .default) { _ in completionHandler(true) })
            presenter.present(dialog, animated: true)
        }

        func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
            guard let presenter = dialogPresenter(for: webView) else {
                completionHandler()
                return
            }
            let dialog = UIAlertController(title: "Dispatch", message: message, preferredStyle: .alert)
            dialog.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
            presenter.present(dialog, animated: true)
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
            if url.scheme == baseURL.scheme && url.host == baseURL.host && url.port == baseURL.port {
                decisionHandler(.allow)
            } else {
                decisionHandler(.cancel)
                if ["https", "tel", "maps"].contains(url.scheme ?? "") { UIApplication.shared.open(url) }
            }
        }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.frameInfo.isMainFrame,
                  message.frameInfo.request.url?.scheme == "https",
                  message.frameInfo.request.url?.host == baseURL.host,
                  message.frameInfo.request.url?.port == baseURL.port,
                  let body = message.body as? [String: Any],
                  let action = body["action"] as? String else { return }
            switch action {
            case "checkIn":
                guard let token = body["token"] as? String,
                      let driver = body["driver"] as? String else { return }
                location.checkIn(token: token, driver: driver)
            case "refresh":
                location.refresh()
            case "checkOut":
                location.checkOut()
            default:
                break
            }
        }
    }
}

// Core Location owns the background lifetime; JavaScript timers never drive native GPS.
final class DriverLocationService: NSObject, ObservableObject, CLLocationManagerDelegate {
    weak var webView: WKWebView?
    var baseURL: URL?
    @Published private(set) var active = false
    @Published private(set) var status = "Checked out"
    @Published private(set) var requiresSettings = false
    private let manager = CLLocationManager()
    private let notifications = DriverNotifications()
    private var token: String?
    private var expiresAt = Date.distantPast
    private var upload: URLSessionDataTask?
    private var generation = UUID()
    private var lastSent = Date.distantPast
    private var lastAcknowledged = Date.distantPast
    private var lastGPSFix = Date.distantPast
    private var lastRecoveryAttempt = Date.distantPast
    private var maintenance: Timer?
    private var deleting = false
    private let pendingKey: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "com.mmpatriots.dispatch.pending-checkouts",
        kSecAttrAccount as String: "pending"
    ]
    private struct PendingCheckout: Codable, Equatable {
        let server: URL
        let token: String
    }
    private var pending: [PendingCheckout] = []

    override init() {
        super.init()
        var query = pendingKey
        query[kSecReturnData as String] = true
        var result: CFTypeRef?
        if SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
           let data = result as? Data {
            pending = (try? JSONDecoder().decode([PendingCheckout].self, from: data)) ?? []
        }
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
        // Receive fresh stationary fixes too; throttle uploads instead of filtering movement.
        manager.distanceFilter = kCLDistanceFilterNone
        manager.activityType = .automotiveNavigation
        manager.pausesLocationUpdatesAutomatically = false
        manager.showsBackgroundLocationIndicator = true
        maintenance = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
            self?.maintain()
        }
        retryCheckout()
    }

    func checkIn(token: String, driver: String) {
        guard !token.isEmpty, !driver.isEmpty, baseURL != nil else { return }
        if active && self.token == token { refresh(); return }
        if active { checkOut() }
        // Read expiry only for local shutdown; the server verifies the signature.
        let parts = token.split(separator: ".")
        guard parts.count == 3 else { report(false, "Invalid session · check in again"); return }
        var payload = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        payload += String(repeating: "=", count: (4 - payload.count % 4) % 4)
        guard let data = Data(base64Encoded: payload),
              let claims = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let expiry = claims["exp"] as? Double, expiry > Date().timeIntervalSince1970 else {
            report(false, "Session expired · check in again"); return
        }
        self.token = token
        if let baseURL { notifications.start(server: baseURL, driver: driver) }
        expiresAt = Date(timeIntervalSince1970: expiry)
        generation = UUID()
        active = true
        lastSent = .distantPast
        lastAcknowledged = .distantPast
        lastGPSFix = Date()
        lastRecoveryAttempt = .distantPast
        refresh()
    }

    func refresh() {
        retryCheckout()
        guard active else { return }
        guard Date() < expiresAt else { checkOut(); return }
        if manager.authorizationStatus != .authorizedAlways || manager.accuracyAuthorization != .fullAccuracy {
            generation = UUID()
            upload?.cancel()
            upload = nil
            lastAcknowledged = .distantPast
        }
        requiresSettings = manager.authorizationStatus == .denied || manager.authorizationStatus == .restricted ||
            manager.authorizationStatus == .authorizedWhenInUse || manager.accuracyAuthorization != .fullAccuracy
        switch manager.authorizationStatus {
        case .notDetermined:
            report(false, "Location required · allow While Using, then Always")
            manager.requestWhenInUseAuthorization()
        case .authorizedWhenInUse:
            manager.stopUpdatingLocation()
            manager.allowsBackgroundLocationUpdates = false
            report(false, "Location required · choose Always in Settings")
            manager.requestAlwaysAuthorization()
        case .authorizedAlways:
            guard manager.accuracyAuthorization == .fullAccuracy else {
                manager.stopUpdatingLocation()
                manager.allowsBackgroundLocationUpdates = false
                report(false, "Location required · enable Precise Location in Settings")
                return
            }
            manager.allowsBackgroundLocationUpdates = true
            manager.startUpdatingLocation()
            report(Date().timeIntervalSince(lastAcknowledged) < 60,
                   Date().timeIntervalSince(lastAcknowledged) < 60 ? "Online · background location active" : "Waiting for a fresh GPS update")
        default:
            manager.stopUpdatingLocation()
            manager.allowsBackgroundLocationUpdates = false
            report(false, "Location required · allow Always and Precise Location in Settings")
        }
    }

    func checkOut() {
        notifications.stop()
        if let token, let baseURL {
            let item = PendingCheckout(server: baseURL, token: token)
            if !pending.contains(item) { pending.append(item); persistPending() }
        }
        active = false
        requiresSettings = false
        generation = UUID()
        upload?.cancel()
        upload = nil
        manager.stopUpdatingLocation()
        manager.allowsBackgroundLocationUpdates = false
        token = nil
        lastAcknowledged = .distantPast
        lastGPSFix = .distantPast
        lastRecoveryAttempt = .distantPast
        report(false, "Checked out · GPS stopped")
        retryCheckout()
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) { refresh() }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        maintain()
        guard active, manager.authorizationStatus == .authorizedAlways,
              manager.accuracyAuthorization == .fullAccuracy, upload == nil,
              Date().timeIntervalSince(lastSent) >= 10,
              let current = locations.last, current.horizontalAccuracy >= 0,
              abs(current.timestamp.timeIntervalSinceNow) < 30 else { return }
        lastGPSFix = current.timestamp
        send(current)
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        if active && Date().timeIntervalSince(lastAcknowledged) >= 60 {
            report(false, "Location unavailable · waiting for GPS or permission")
        }
    }

    func locationManagerDidPauseLocationUpdates(_ manager: CLLocationManager) {
        guard active else { return }
        report(false, "GPS paused · restarting location updates")
        recoverStalledGPS()
    }

    private func maintain() {
        retryCheckout()
        guard active else { return }
        if Date() >= expiresAt { checkOut(); return }
        if let baseURL, let token { notifications.poll(server: baseURL, token: token) }
        if manager.authorizationStatus == .authorizedAlways && manager.accuracyAuthorization == .fullAccuracy && Date().timeIntervalSince(lastAcknowledged) >= 60 {
            report(false, "Location required · no recent update delivered")
            if Date().timeIntervalSince(lastGPSFix) >= 90 { recoverStalledGPS() }
        }
    }

    private func recoverStalledGPS() {
        guard active, Date() < expiresAt,
              manager.authorizationStatus == .authorizedAlways,
              manager.accuracyAuthorization == .fullAccuracy,
              Date().timeIntervalSince(lastRecoveryAttempt) >= 120 else { return }
        lastRecoveryAttempt = Date()
        // A background timer is not guaranteed to run; this also handles Core Location pause callbacks.
        manager.stopUpdatingLocation()
        manager.allowsBackgroundLocationUpdates = true
        manager.startUpdatingLocation()
    }

    private func send(_ position: CLLocation) {
        guard let baseURL, let token else { return }
        let currentGeneration = generation
        lastSent = Date()
        var request = URLRequest(url: baseURL.appendingPathComponent("api/driver-location"))
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: [
            "latitude": position.coordinate.latitude,
            "longitude": position.coordinate.longitude,
            "accuracy": position.horizontalAccuracy,
            "recordedAt": ISO8601DateFormatter().string(from: position.timestamp)
        ])
        let lease = BackgroundLease("Send Driver Location")
        upload = URLSession.shared.dataTask(with: request) { [weak self] _, response, error in
            DispatchQueue.main.async {
                defer { lease.end() }
                guard let self, self.active, self.generation == currentGeneration else { return }
                self.upload = nil
                if error == nil, (response as? HTTPURLResponse)?.statusCode == 200 {
                    self.lastAcknowledged = position.timestamp
                    self.report(Date().timeIntervalSince(position.timestamp) < 60, "Online · background location active")
                } else if [401, 403].contains((response as? HTTPURLResponse)?.statusCode ?? 0) {
                    self.checkOut()
                    self.report(false, "Session ended · check out and sign in again")
                } else {
                    self.report(false, "Offline · cannot deliver location to Dispatch")
                }
            }
        }
        upload?.resume()
    }

    private func persistPending() {
        guard let data = try? JSONEncoder().encode(pending) else { return }
        let values: [String: Any] = [kSecValueData as String: data]
        if SecItemUpdate(pendingKey as CFDictionary, values as CFDictionary) == errSecItemNotFound {
            var query = pendingKey
            query[kSecValueData as String] = data
            query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            SecItemAdd(query as CFDictionary, nil)
        }
    }

    private func retryCheckout() {
        guard !deleting, let item = pending.first else { return }
        deleting = true
        var request = URLRequest(url: item.server.appendingPathComponent("api/driver-location"))
        request.httpMethod = "DELETE"
        request.timeoutInterval = 15
        request.setValue("Bearer \(item.token)", forHTTPHeaderField: "Authorization")
        let lease = BackgroundLease("Stop Driver Location")
        URLSession.shared.dataTask(with: request) { [weak self] _, response, error in
            DispatchQueue.main.async {
                defer { lease.end() }
                guard let self else { return }
                self.deleting = false
                let code = (response as? HTTPURLResponse)?.statusCode ?? 0
                if error == nil && (code == 200 || code == 401) {
                    self.pending.removeAll { $0 == item }
                    self.persistPending()
                } else if !self.active {
                    self.report(false, "GPS stopped · Dispatch checkout pending network")
                }
            }
        }.resume()
    }

    private func report(_ online: Bool, _ message: String) {
        status = message
        guard let webView,
              let json = try? JSONSerialization.data(withJSONObject: [online, message, ISO8601DateFormatter().string(from: lastAcknowledged)]),
              let argument = String(data: json, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.nativeLocationState?.apply(null, \(argument))")
    }
}

// End each finite network allowance on completion or expiration, exactly once.
private final class BackgroundLease {
    private var identifier: UIBackgroundTaskIdentifier = .invalid
    init(_ name: String) {
        identifier = UIApplication.shared.beginBackgroundTask(withName: name) { [weak self] in self?.end() }
    }
    func end() {
        guard identifier != .invalid else { return }
        UIApplication.shared.endBackgroundTask(identifier)
        identifier = .invalid
    }
}
