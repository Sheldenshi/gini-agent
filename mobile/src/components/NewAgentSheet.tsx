import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { family, theme } from "@/src/theme";

// Name-entry modal for creating an agent. Presented over a dimmed scrim
// (tap to dismiss) and lifted above the keyboard so the "Agent name" field
// stays visible while typing. The card floats above the home indicator with
// side margins rather than sitting flush at the screen's bottom edge.
export function NewAgentSheet({
  visible,
  name,
  error,
  creating,
  onChangeName,
  onSubmit,
  onCancel
}: {
  visible: boolean;
  name: string;
  error: string | null;
  creating: boolean;
  onChangeName: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  // Read insets from context rather than a <SafeAreaView>: the card renders
  // inside a <Modal> (a separate native hierarchy on iOS), so the
  // context-provided values are the reliable measured insets here.
  const insets = useSafeAreaInsets();
  if (!visible) return null;
  const submitDisabled = creating || name.trim().length === 0;
  return (
    <Modal
      visible
      transparent
      animationType="fade"
      onRequestClose={onCancel}
      statusBarTranslucent
    >
      <View style={styles.root}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onCancel}
          accessibilityRole="button"
          accessibilityLabel="Dismiss new agent"
        >
          <View style={styles.backdrop} />
        </Pressable>
        {/* `box-none` lets taps in the empty area around the card fall through
            to the scrim Pressable behind it, while the card still captures its
            own touches. `padding` lifts the card by the keyboard's height. */}
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          keyboardVerticalOffset={0}
          style={styles.avoider}
          pointerEvents="box-none"
        >
          <View style={[styles.card, { marginBottom: insets.bottom + 16 }]}>
            <Text style={styles.title}>New agent</Text>
            <TextInput
              value={name}
              onChangeText={onChangeName}
              placeholder="Agent name"
              placeholderTextColor={theme.placeholder}
              autoFocus
              autoCapitalize="words"
              autoCorrect={false}
              returnKeyType="done"
              onSubmitEditing={() => {
                if (!submitDisabled) onSubmit();
              }}
              editable={!creating}
              style={styles.input}
              accessibilityLabel="Agent name"
            />
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <View style={styles.actions}>
              <TouchableOpacity
                onPress={onCancel}
                disabled={creating}
                style={[styles.button, styles.cancel]}
                accessibilityRole="button"
                accessibilityLabel="Cancel"
              >
                <Text style={styles.cancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={onSubmit}
                disabled={submitDisabled}
                style={[
                  styles.button,
                  styles.submit,
                  submitDisabled && styles.buttonDisabled
                ]}
                accessibilityRole="button"
                accessibilityLabel="Create agent"
              >
                {creating ? (
                  <ActivityIndicator color={theme.buttonText} />
                ) : (
                  <Text style={styles.submitText}>Create</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)" },
  // Fills the screen above the scrim and parks the card at the bottom; the
  // padding behavior shrinks this box when the keyboard opens, sliding the
  // card up with it.
  avoider: { flex: 1, justifyContent: "flex-end" },
  card: {
    marginHorizontal: 16,
    backgroundColor: theme.bg,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.inputBorder,
    padding: 16,
    gap: 12,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 16,
    elevation: 8
  },
  title: {
    color: theme.text,
    fontFamily: family("HankenGrotesk", 700),
    fontSize: 17
  },
  input: {
    backgroundColor: theme.bg,
    color: theme.text,
    fontFamily: family("HankenGrotesk", 400),
    fontSize: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.inputBorder
  },
  error: {
    color: theme.danger,
    fontFamily: family("HankenGrotesk", 400),
    fontSize: 13
  },
  actions: { flexDirection: "row", gap: 8 },
  button: {
    flex: 1,
    height: 44,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center"
  },
  cancel: { backgroundColor: theme.bg, borderWidth: 1, borderColor: theme.inputBorder },
  cancelText: {
    color: theme.text,
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 15
  },
  submit: { backgroundColor: theme.accent },
  submitText: {
    color: theme.buttonText,
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 15
  },
  buttonDisabled: { opacity: 0.5 }
});
