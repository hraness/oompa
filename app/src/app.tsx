import { AppearanceHeader } from "./components/appearance";
import { ConvexAuthProvider, useConvexAuth } from "@convex-dev/auth/react";
import * as stylex from "@stylexjs/stylex";

import { convexClient } from "./auth/convex-client";
import { memoryTokenStorage } from "./auth/memory-token-storage";
import { SignInScreen } from "./auth/sign-in-screen";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card";
import { ErrorBoundary } from "./components/error-boundary";
import { CustodyProvider, useCustody } from "./custody/custody-context";
import { EnrollmentScreen } from "./custody/enrollment-screen";
import { CommandReceiptRecovery } from "./data/command-receipt-recovery";
import { navigateBack, useRoute } from "./routing/router";
import { GridScreen } from "./screens/grid-screen";
import { SettingsScreen } from "./screens/settings-screen";
import { appStyles } from "./app.stylex";

function Centered({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <main {...stylex.props(appStyles.centered)}>
      <AppearanceHeader />
      {children}
    </main>
  );
}

/** The routed screens: the grid of conversations, and settings. */
function RoutedScreens() {
  const route = useRoute();
  switch (route.kind) {
    case "settings":
      return <SettingsScreen onBack={navigateBack} section={route.section} />;
    case "grid":
      return <GridScreen />;
  }
}

function CustodyGate() {
  const custody = useCustody();
  switch (custody.state) {
    case "unlocked":
      return (
        <ErrorBoundary
          fallback={(error, reset) => (
            <Centered>
              <Card>
                <CardHeader>
                  <CardTitle>Something failed</CardTitle>
                  <CardDescription>{error.message}</CardDescription>
                </CardHeader>
                <CardContent>
                  <Button onClick={reset} variant="secondary">Try again</Button>
                </CardContent>
              </Card>
            </Centered>
          )}
          onError={custody.reportAuthorityFailure}
        >
          <CommandReceiptRecovery />
          <RoutedScreens />
        </ErrorBoundary>
      );
    case "unlocking":
    case "unenrolled":
    default:
      return <EnrollmentScreen />;
  }
}

function AuthGate() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  if (isLoading) {
    return (
      <Centered>
        <p {...stylex.props(appStyles.quiet)}>Checking your session.</p>
      </Centered>
    );
  }
  if (!isAuthenticated) return <SignInScreen />;
  return (
    <CustodyProvider>
      <CustodyGate />
    </CustodyProvider>
  );
}

/**
 * Authentication tokens live in `memoryTokenStorage`, never in `localStorage`.
 * A reload asks for a new one-time code and a closed tab leaves no refresh token
 * behind (Oompa v2 F5).
 */
export function App() {
  return (
    <ConvexAuthProvider client={convexClient} storage={memoryTokenStorage}>
      <AuthGate />
    </ConvexAuthProvider>
  );
}
