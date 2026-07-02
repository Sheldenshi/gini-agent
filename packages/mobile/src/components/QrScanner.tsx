import { CameraView, useCameraPermissions, type BarcodeScanningResult } from "expo-camera";
import { useEffect, useRef } from "react";
import { Modal, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { family, theme } from "@/src/theme";

// Full-screen QR scanner presented over the pair screen. Decodes a single QR and
// hands its raw payload back via onScanned; the caller validates it (same path as
// a pasted link). Camera-permission and the duplicate-frame latch live here so the
// pair screen stays focused on the handshake state machine.
export function QrScanner({
  onScanned,
  onClose
}: {
  onScanned: (data: string) => void;
  onClose: () => void;
}) {
  const [permission, requestPermission] = useCameraPermissions();
  // onBarcodeScanned fires every frame the code is visible — latch so only the
  // first decode is delivered, even if onScanned navigates asynchronously.
  const lockRef = useRef(false);
  // Ask once on first mount when the status is still undetermined, so the user
  // lands straight on the live camera instead of a permission wall. After a denial
  // canAskAgain flips false, so this can't loop.
  const askedRef = useRef(false);

  useEffect(() => {
    if (!askedRef.current && permission && !permission.granted && permission.canAskAgain) {
      askedRef.current = true;
      void requestPermission();
    }
  }, [permission, requestPermission]);

  const handleScanned = (result: BarcodeScanningResult) => {
    if (lockRef.current) return;
    lockRef.current = true;
    onScanned(result.data);
  };

  return (
    <Modal animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
        {!permission ? (
          <View style={styles.center} />
        ) : !permission.granted ? (
          <View style={styles.center}>
            <Text style={styles.message}>
              {permission.canAskAgain
                ? "Allow camera access to scan the pairing QR code."
                : "Camera access is off. Enable it in Settings, then try again."}
            </Text>
            {permission.canAskAgain ? (
              <TouchableOpacity onPress={() => void requestPermission()} style={styles.button}>
                <Text style={styles.buttonText}>Allow camera</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ) : (
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={handleScanned}
          />
        )}

        <View style={styles.topBar} pointerEvents="none">
          <Text style={styles.title}>Scan the Gini QR code</Text>
        </View>
        <TouchableOpacity onPress={onClose} style={styles.cancel}>
          <Text style={styles.cancelText}>Cancel</Text>
        </TouchableOpacity>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 16 },
  message: {
    color: theme.bg,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 16,
    textAlign: "center",
    lineHeight: 22
  },
  topBar: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    paddingTop: 64,
    alignItems: "center"
  },
  title: {
    color: theme.bg,
    fontFamily: family("HankenGrotesk", 700),
    fontSize: 18
  },
  button: {
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderRadius: 10,
    backgroundColor: theme.button
  },
  buttonText: {
    color: theme.buttonText,
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 16
  },
  cancel: {
    position: "absolute",
    bottom: 48,
    alignSelf: "center",
    paddingVertical: 12,
    paddingHorizontal: 28,
    borderRadius: 24,
    backgroundColor: "rgba(0,0,0,0.6)"
  },
  cancelText: {
    color: theme.bg,
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 16
  }
});
