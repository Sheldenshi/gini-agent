import { beforeEach, describe, expect, mock, test } from "bun:test";

// Identity-comparable stand-ins for the native primitives the sheet renders.
// Tests never mount them; they assert on element.type === Modal etc. and walk
// element.props.children. Each carries a `displayName` so failures read clearly.
function makeStub(name: string) {
  const C = () => null;
  C.displayName = name;
  return C;
}
const Modal = makeStub("Modal");
const KeyboardAvoidingView = makeStub("KeyboardAvoidingView");
const Pressable = makeStub("Pressable");
const Text = makeStub("Text");
const TextInput = makeStub("TextInput");
const TouchableOpacity = makeStub("TouchableOpacity");
const View = makeStub("View");
const ActivityIndicator = makeStub("ActivityIndicator");

const Platform = { OS: "ios" as "ios" | "android" | "web" };

// bun's `mock.module` is process-global, so a serial run that shares a process
// with other component tests (e.g. the chat suite) would otherwise see this
// react-native stub clobber theirs. Provide a superset that also carries the
// keys those tests read (Linking/Share/Animated/Easing/useWindowDimensions),
// so whichever file's mock wins last keeps every consumer satisfied. The
// project's `bun test --parallel` runs each file in its own worker, where this
// never collides, but the superset keeps a serial subset run green too.
const noop = () => null;
mock.module("react-native", () => ({
  Platform,
  Modal,
  KeyboardAvoidingView,
  Pressable,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  ActivityIndicator,
  Share: { share: () => Promise.resolve({}) },
  Linking: { openURL: () => Promise.resolve() },
  useWindowDimensions: () => ({ width: 400, height: 800 }),
  Animated: {
    View: noop,
    Value: function Value(this: { v: number }, v: number) {
      this.v = v;
    },
    loop: () => ({ start: () => {}, stop: () => {} }),
    sequence: () => ({}),
    timing: () => ({}),
    parallel: () => ({ start: () => {}, stop: () => {} })
  },
  Easing: { inOut: (e: unknown) => e, ease: () => ({}) },
  StyleSheet: {
    create: (s: unknown) => s,
    hairlineWidth: 1,
    absoluteFill: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
    absoluteFillObject: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }
  }
}));

mock.module("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 34, left: 0, right: 0 })
}));

mock.module("@/src/theme", () => ({
  theme: {
    bg: "#FFFFFF",
    text: "#1A1A1A",
    placeholder: "#9A9A9A",
    inputBorder: "#E2E2E5",
    border: "#ECECEC",
    borderStrong: "#D1D1D6",
    accent: "#007AFF",
    danger: "#FF3B30",
    buttonText: "#FFFFFF"
  },
  family: (name: string, weight = 400) => `${name}_${weight}`
}));

const { NewAgentSheet } = await import("@/src/components/NewAgentSheet");

type El = {
  type: unknown;
  props: { children?: unknown; [k: string]: unknown };
} | null | undefined | string | number | boolean;

// Flatten a React element tree into a list of every element node so a test can
// search for a primitive type or a prop anywhere in the tree without hardcoding
// the nesting depth.
function flatten(node: El, out: Array<Exclude<El, null | undefined | string | number | boolean>> = []) {
  if (!node || typeof node !== "object") return out;
  out.push(node);
  const kids = node.props?.children;
  const list = Array.isArray(kids) ? kids : [kids];
  for (const k of list) flatten(k as El, out);
  return out;
}

function render(overrides: Partial<Parameters<typeof NewAgentSheet>[0]> = {}) {
  const props = {
    visible: true,
    name: "",
    error: null,
    creating: false,
    onChangeName: () => {},
    onSubmit: () => {},
    onCancel: () => {},
    ...overrides
  };
  // Invoke as a plain function (the codebase's component-test convention).
  return (NewAgentSheet as unknown as (p: typeof props) => El)(props);
}

// Pin the platform before every test so a case that flips it to "android"
// can't leak that value into a later iOS-behavior assertion if it throws
// before restoring — mirrors the sibling chat component tests.
beforeEach(() => {
  Platform.OS = "ios";
});

describe("bug #371: New Agent sheet keyboard + backdrop", () => {
  test("wraps its content in a KeyboardAvoidingView so the keyboard can't cover the field", () => {
    const tree = render();
    const nodes = flatten(tree);
    const hasKAV = nodes.some((n) => n.type === KeyboardAvoidingView);
    expect(hasKAV).toBe(true);
  });

  test("renders a dimmed backdrop scrim behind the sheet", () => {
    const tree = render();
    const nodes = flatten(tree);
    // The scrim is a full-bleed layer with a semi-transparent black fill.
    const hasScrim = nodes.some((n) => {
      const style = n.props?.style as
        | { backgroundColor?: string }
        | Array<{ backgroundColor?: string }>
        | undefined;
      const styles = Array.isArray(style) ? style : [style];
      return styles.some(
        (s) => typeof s?.backgroundColor === "string" && /^rgba\(0,\s*0,\s*0,/.test(s.backgroundColor)
      );
    });
    expect(hasScrim).toBe(true);
  });

  test("the backdrop is tappable to dismiss (calls onCancel)", () => {
    let cancelled = false;
    const tree = render({ onCancel: () => (cancelled = true) });
    const nodes = flatten(tree);
    // The outermost Pressable in the tree is the scrim dismiss target.
    const pressable = nodes.find((n) => n.type === Pressable);
    expect(pressable).toBeDefined();
    const onPress = pressable?.props?.onPress as (() => void) | undefined;
    expect(typeof onPress).toBe("function");
    onPress?.();
    expect(cancelled).toBe(true);
  });

  test("the Android back gesture (onRequestClose) dismisses when idle", () => {
    let cancelled = false;
    const modal = flatten(render({ onCancel: () => (cancelled = true) })).find(
      (n) => n.type === Modal
    );
    (modal?.props?.onRequestClose as () => void)();
    expect(cancelled).toBe(true);
  });

  test("backdrop tap and back gesture are inert while creating", () => {
    let cancelled = 0;
    const nodes = flatten(render({ creating: true, onCancel: () => (cancelled += 1) }));
    const backdrop = nodes.find((n) => n.type === Pressable);
    const modal = nodes.find((n) => n.type === Modal);
    (backdrop?.props?.onPress as () => void)();
    (modal?.props?.onRequestClose as () => void)();
    expect(cancelled).toBe(0);
  });

  test("still renders the Agent name input and Create control", () => {
    const tree = render();
    const nodes = flatten(tree);
    const input = nodes.find((n) => n.type === TextInput);
    expect(input).toBeDefined();
    expect(input?.props?.accessibilityLabel).toBe("Agent name");
    const create = nodes.find((n) => n.props?.accessibilityLabel === "Create agent");
    expect(create).toBeDefined();
  });

  test("renders nothing when not visible", () => {
    expect(render({ visible: false })).toBeNull();
  });
});

describe("New Agent sheet input + submit wiring", () => {
  function findInput(overrides: Partial<Parameters<typeof NewAgentSheet>[0]> = {}) {
    const nodes = flatten(render(overrides));
    const input = nodes.find((n) => n.type === TextInput);
    if (!input) throw new Error("TextInput not found");
    return input;
  }

  test("submitting the keyboard's done key fires onSubmit when a name is present", () => {
    let submitted = 0;
    const input = findInput({ name: "Atlas", onSubmit: () => (submitted += 1) });
    (input.props.onSubmitEditing as () => void)();
    expect(submitted).toBe(1);
  });

  test("submitting the keyboard's done key is a no-op when the name is blank", () => {
    let submitted = 0;
    const input = findInput({ name: "   ", onSubmit: () => (submitted += 1) });
    (input.props.onSubmitEditing as () => void)();
    expect(submitted).toBe(0);
  });

  test("submitting the keyboard's done key is a no-op while creating", () => {
    let submitted = 0;
    const input = findInput({ name: "Atlas", creating: true, onSubmit: () => (submitted += 1) });
    (input.props.onSubmitEditing as () => void)();
    expect(submitted).toBe(0);
    // The field is locked while the create request is in flight.
    expect(input.props.editable).toBe(false);
  });

  test("renders the error message when present", () => {
    const nodes = flatten(render({ error: "Name taken" }));
    const hasError = nodes.some(
      (n) => n.type === Text && n.props.children === "Name taken"
    );
    expect(hasError).toBe(true);
  });

  test("shows a spinner instead of the Create label while creating", () => {
    const nodes = flatten(render({ name: "Atlas", creating: true }));
    expect(nodes.some((n) => n.type === ActivityIndicator)).toBe(true);
    expect(nodes.some((n) => n.type === Text && n.props.children === "Create")).toBe(false);
  });

  test("on Android the keyboard avoider uses the undefined behavior", () => {
    Platform.OS = "android";
    const kav = flatten(render()).find((n) => n.type === KeyboardAvoidingView);
    expect(kav?.props.behavior).toBeUndefined();
  });
});
