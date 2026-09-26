# Dispatch iPhone app (background driver location)

This native iOS shell loads the existing HTTPS Dispatch server. Driver Check In in the web screen passes the authenticated driver session to Core Location. The native component sends positions to `POST /api/driver-location` while the shift is active, including when the phone is locked or the app is in the background. Check Out stops updates and deletes the current position.

## Build on a Mac

1. Install Xcode and XcodeGen. In this directory run `xcodegen generate`, then open `MMPatriotsDispatch.xcodeproj`.
2. Select the MMPatriotsDispatch target. Set a unique Bundle Identifier and your Apple Developer team under Signing & Capabilities.
3. Verify Background Modes includes **Location updates**. The supplied Info.plist contains `UIBackgroundModes/location` and both location permission descriptions.
4. Build on a real iPhone. At first launch enter the HTTPS URL of the deployed Dispatch server (the same URL the existing web app uses).
5. Sign in as a driver with Driver Check In. Grant location permission. To support background tracking beyond an active session, choose **Always** when iOS offers it. Check that Dispatch shows the driver's location, then lock the phone and drive to test updates. Check Out must stop sharing.

The project requires a real iPhone and Xcode for validation. Core Location sends updates according to iOS and movement, so the server shows a timestamp and labels old positions as last known. The app cannot send a current position when the phone is off, disconnected, permissions are revoked, or iOS has stopped the process. A driver session expires after 12 hours and requires a new Check In.

Before App Store submission, provide an app icon, final Bundle Identifier, privacy disclosures, and test the actual signed build on driver devices.
