import { forwardRef, type ReactNode } from "react";
import {
  Platform,
  StyleSheet,
  Text,
  TextInput,
  type StyleProp,
  type TextStyle
} from "react-native";

// iOS `<Text selectable>` only ever offers "Copy the whole Text" — it
// does not show draggable selection handles. The only built-in primitive
// that does is `<TextInput multiline editable={false}>`: iOS treats it as
// a non-editable rich text view with the loupe, handles, and Copy/Share
// menu. Multiline TextInput accepts nested <Text> children and renders
// them as attributed text, so inline markdown styling (bold, italic,
// links, color) is preserved.
//
// Android `<Text selectable>` already shows native selection handles, so
// we keep Text there. Browsers handle text selection natively on the
// `<div>` that RN Web emits for Text, so we keep Text on web too. Only
// iOS needs the TextInput swap.
//
// Per-paragraph TextInputs means selection can't span across paragraphs
// — that is a deliberate trade-off vs. losing markdown rendering or
// shipping a native module.
export const SelectableBlockText = forwardRef<unknown, {
  style?: StyleProp<TextStyle>;
  children?: ReactNode;
}>(function SelectableBlockText({ style, children }, _ref) {
  if (Platform.OS === "ios") {
    return (
      <TextInput
        multiline
        editable={false}
        scrollEnabled={false}
        // Reset TextInput's built-in chrome so it visually matches Text:
        // no border, no internal padding, no caret blink when focused.
        // `textAlignVertical` keeps long wrapped paragraphs anchored to
        // the top of the line box on Android (no-op on iOS but harmless).
        style={[iosResets.input, style]}
        caretHidden
        contextMenuHidden={false}
      >
        {children}
      </TextInput>
    );
  }
  return (
    <Text style={style} selectable>
      {children}
    </Text>
  );
});

const iosResets = StyleSheet.create({
  input: {
    padding: 0,
    margin: 0,
    borderWidth: 0
  }
});
