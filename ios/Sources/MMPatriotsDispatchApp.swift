import SwiftUI
import WebKit
import CoreLocation
import UIKit

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
    @AppStorage("dispatchServerURL") private var serverURL = ""
    @State private var enteredURL = ""
    @State private var error = ""

    private var configuredURL: URL? {
        guard let url = URL(string: serverURL),
              url.scheme == "https", url.host != nil,
              (url.path.isEmpty || url.path == "/"),
              url.query == nil, url.fragment == nil else { return nil }
        return url
    }

    var body: some View {
        if let url = configuredURL {
            VStack(spacing: 0) {
                HStack {
                    Text("Dispatch").font(.headline)
                    Spacer()
                    Button("Change Server") {
                        location.checkOut()
                        serverURL = ""
                    }
                }
                .padding(10)
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
                              url.host != nil, (url.path.isEmpty || url.path == "/"),
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
}

struct WebContainer: UIViewRepresentable {
    let baseURL: URL
    let location: DriverLocationService

    func makeCoordinator() -> Coordinator { Coordinator(baseURL: baseURL, location: location) }

    func makeUIView(context: Context) -> WKWebView {
        let controller = WKUserContentController()
        controller.add(context.coordinator, name: "driverLocation")
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = controller
        let webView = WKWebView(frame: .zero, configuration: configuration)
        context.coordinator.webView = webView
        location.webView = webView
        location.baseURL = baseURL
        webView.load(URLRequest(url: baseURL))
        return webView
    }

    func updateUIView(_ view: WKWebView, context: Context) {}

    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        view.configuration.userContentController.removeScriptMessageHandler(forName: "driverLocation")
    }

    final class Coordinator: NSObject, WKScriptMessageHandler {
        let baseURL: URL
        let location: DriverLocationService
        weak var webView: WKWebView?

        init(baseURL: URL, location: DriverLocationService) {
            self.baseURL = baseURL
            self.location = location
        }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.frameInfo.isMainFrame,
                  message.frameInfo.request.url?.scheme == "https",
                  message.frameInfo.request.url?.host == baseURL.host,
                  let body = message.body as? [String: Any],
                  let action = body["action"] as? String else { return }
            switch action {
            case "checkIn":
                guard let token = body["token"] as? String,
                      let driver = body["driver"] as? String else { return }
                location.checkIn(token: token, driver: driver)
            case "checkOut":
                location.checkOut()
            default:
                break
            }
        }
    }
}

final class DriverLocationService: NSObject, ObservableObject, CLLocationManagerDelegate {
    weak var webView: WKWebView?
    var baseURL: URL?
    private let manager = CLLocationManager()
    private var token: String?
    private var driver: String?
    private var active = false
    private var sending = false

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.distanceFilter = 15
        manager.activityType = .automotiveNavigation
        manager.pausesLocationUpdatesAutomatically = false
        manager.showsBackgroundLocationIndicator = true
    }

    func checkIn(token: String, driver: String) {
        guard !token.isEmpty, !driver.isEmpty, baseURL != nil else {
            report(false, "Offline · server connection unavailable")
            return
        }
        if active && self.token == token && self.driver == driver { return }
        if active { checkOut() }
        self.token = token
        self.driver = driver
        active = true
        report(false, "Requesting iPhone location permission…")
        switch manager.authorizationStatus {
        case .notDetermined, .authorizedWhenInUse:
            manager.requestAlwaysAuthorization()
            if manager.authorizationStatus == .authorizedWhenInUse { startUpdates() }
        case .authorizedAlways:
            startUpdates()
        default:
            report(false, "Offline · allow location in iPhone Settings")
        }
    }

    func checkOut() {
        let oldToken = token
        active = false
        sending = false
        manager.stopUpdatingLocation()
        manager.allowsBackgroundLocationUpdates = false
        token = nil
        driver = nil
        report(false, "Checked out · location sharing stopped")
        if let oldToken { deleteLocation(token: oldToken) }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard active else { return }
        switch manager.authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse:
            startUpdates()
        default:
            manager.stopUpdatingLocation()
            report(false, "Offline · location permission required")
        }
    }

    private func startUpdates() {
        guard active else { return }
        manager.allowsBackgroundLocationUpdates = true
        manager.startUpdatingLocation()
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard active, !sending,
              let current = locations.last,
              current.horizontalAccuracy >= 0,
              abs(current.timestamp.timeIntervalSinceNow) < 120 else { return }
        send(current)
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        report(false, "Offline · location update failed")
    }

    private func send(_ position: CLLocation) {
        guard let baseURL, let token else { return }
        sending = true
        var request = URLRequest(url: baseURL.appendingPathComponent("api/driver-location"))
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: [
            "latitude": position.coordinate.latitude,
            "longitude": position.coordinate.longitude,
            "accuracy": position.horizontalAccuracy
        ])
        let task = UIApplication.shared.beginBackgroundTask(withName: "Send Driver Location")
        URLSession.shared.dataTask(with: request) { [weak self] _, response, error in
            DispatchQueue.main.async {
                guard let self else {
                    UIApplication.shared.endBackgroundTask(task)
                    return
                }
                self.sending = false
                if self.active && self.token == token {
                    if error == nil, let http = response as? HTTPURLResponse, http.statusCode == 200 {
                        self.report(true, "Online · background location active")
                    } else if (response as? HTTPURLResponse)?.statusCode == 401 {
                        self.checkOut()
                        self.report(false, "Offline · session expired; check in again")
                    } else {
                        self.report(false, "Offline · location cannot reach Dispatch")
                    }
                } else {
                    self.deleteLocation(token: token)
                }
                UIApplication.shared.endBackgroundTask(task)
            }
        }.resume()
    }

    private func deleteLocation(token: String) {
        guard let baseURL else { return }
        var request = URLRequest(url: baseURL.appendingPathComponent("api/driver-location"))
        request.httpMethod = "DELETE"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        URLSession.shared.dataTask(with: request).resume()
    }

    private func report(_ online: Bool, _ message: String) {
        guard let webView,
              let json = try? JSONSerialization.data(withJSONObject: [online, message]),
              let argument = String(data: json, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.nativeLocationState?.apply(null, \(argument))")
    }
}
