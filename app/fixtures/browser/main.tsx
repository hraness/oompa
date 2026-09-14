import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import * as stylex from "@stylexjs/stylex";
import { SignInScreen } from "../../src/auth/sign-in-screen";
import { EnrollmentScreen } from "../../src/custody/enrollment-screen";
import { GridScreen } from "../../src/screens/grid-screen";
import { SessionCard } from "../../src/components/session-card";
import { SettingsScreen } from "../../src/screens/settings-screen";
import { Button } from "../../src/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../src/components/ui/card";
import { Dialog, DialogTitle } from "../../src/components/ui/dialog";
import { DropdownMenu } from "../../src/components/ui/dropdown-menu";
import { Input } from "../../src/components/ui/input";
import { Sheet } from "../../src/components/ui/sheet";
import { Switch } from "../../src/components/ui/switch";
import { browserHead } from "./io";
import { fixtureStyles } from "./main.stylex";
import "@hraness/design-kit/compiler-palettes.css";
import "../../src/index.css";

function Primitives() {
  const [dialog, setDialog] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [rightSheet, setRightSheet] = useState(false);
  const [checked, setChecked] = useState(false);
  const [selection, setSelection] = useState("none");
  return <Card>
    <CardHeader><CardTitle>Native fixture controls</CardTitle></CardHeader>
    <CardContent>
      {/* Preserve ordinary block flow for the default button presentation check. */}
      <Button onClick={() => { setDialog(true); }}>Open dialog</Button>
      <div {...stylex.props(fixtureStyles.controls)}>
        <Button onClick={() => { setSheet(true); }}>Open sheet</Button>
        <Button onClick={() => { setRightSheet(true); }}>Open right sheet</Button>
        <Button disabled>Disabled button</Button>
        <Switch checked={checked} label="Fixture switch" onCheckedChange={setChecked} />
        <Switch checked={false} disabled label="Disabled switch" onCheckedChange={() => { throw new Error("Disabled switch activated"); }} />
        <DropdownMenu label="Fixture menu" trigger="Menu" items={[
          { id: "disabled", label: "Disabled item", disabled: true, onSelect: () => { throw new Error("Disabled menu item activated"); } },
          { id: "select", label: "Select item", onSelect: () => { setSelection("selected"); } },
        ]} />
        <output aria-label="Menu selection">{selection}</output>
      </div>
      <Dialog label="Fixture dialog" onClose={() => { setDialog(false); }} open={dialog}>
        <DialogTitle>Native modal</DialogTitle>
        <Input aria-label="Modal text" />
        <Button onClick={() => { setDialog(false); }}>Close dialog</Button>
      </Dialog>
      <Sheet label="Fixture sheet" onClose={() => { setSheet(false); }} open={sheet}>
        <Button onClick={() => { setSheet(false); }}>Close sheet</Button>
      </Sheet>
      <Sheet label="Fixture right sheet" onClose={() => { setRightSheet(false); }} open={rightSheet} side="right">
        <Button onClick={() => { setRightSheet(false); }}>Close right sheet</Button>
      </Sheet>
    </CardContent>
  </Card>;
}

const noOrdering = {
  arranged: false,
  canMoveLeft: false,
  canMoveRight: false,
  dragging: false,
  dropTarget: false,
  onDragStart: () => undefined,
  onMove: () => undefined,
  onReset: () => undefined,
} as const;

function SingleCard() {
  return <div {...stylex.props(fixtureStyles.single)}>
    <SessionCard head={browserHead} onSummary={() => undefined} ordering={noOrdering} />
  </div>;
}

function Fixture() {
  const view = new URLSearchParams(location.search).get("view");
  switch (view) {
    case "signin": return <SignInScreen />;
    case "enrollment": return <EnrollmentScreen />;
    case "grid": return <GridScreen />;
    case "session":
    case "session-long":
    case "retired": return <SingleCard />;
    case "settings": return <SettingsScreen onBack={() => undefined} />;
    case "primitives": return <Primitives />;
    case null:
    default: throw new Error("Unknown browser fixture view");
  }
}

const container = document.getElementById("root");
if (container === null) throw new Error("Missing browser fixture root");
createRoot(container).render(<StrictMode><Fixture /></StrictMode>);
