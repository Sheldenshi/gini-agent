import { Feather } from "@expo/vector-icons";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { fileAccent } from "@/src/file-accent";
import { family, theme } from "@/src/theme";
import { useFilePreview } from "@/src/components/FilePreview";

// Grouped attachment card for the files an agent generated in one exchange.
// The chat otherwise buries file_write/file_patch calls inside the collapsed
// tool group, so this surfaces every generated file as one card with a row
// per file (icon swatch, filename, directory, chevron). Tapping a row opens
// the file preview bottom sheet for that path. Rendered as its own
// `file_artifact` render item directly below the agent's reply.
export function GeneratedFilesCard({ files }: { files: { path: string; toolName: string }[] }) {
  const { open } = useFilePreview();
  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Feather name="folder" size={14} color={theme.muted} />
        <Text style={styles.headerText}>
          {files.length} file{files.length === 1 ? "" : "s"} generated
        </Text>
      </View>
      {files.map((file, index) => (
        <FileRow
          key={file.path}
          path={file.path}
          first={index === 0}
          onPress={() => open({ path: file.path })}
        />
      ))}
    </View>
  );
}

function FileRow({
  path,
  first,
  onPress
}: {
  path: string;
  first: boolean;
  onPress: () => void;
}) {
  const lastSlash = path.lastIndexOf("/");
  const filename = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
  const dir = lastSlash > 0 ? path.slice(0, lastSlash) : "";
  const accent = fileAccent(path);

  return (
    <Pressable
      onPress={onPress}
      style={[styles.row, !first && styles.rowDivider]}
      accessibilityRole="button"
      accessibilityLabel={`Preview ${filename}`}
    >
      <View style={[styles.swatch, { backgroundColor: accent.bg }]}>
        <Feather name="file-text" size={19} color={accent.fg} />
      </View>
      <View style={styles.textColumn}>
        <Text style={styles.filename} numberOfLines={1}>
          {filename}
        </Text>
        {dir ? (
          <Text style={styles.dir} numberOfLines={1}>
            {dir}
          </Text>
        ) : null}
      </View>
      <Feather name="chevron-right" size={18} color={theme.muted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    alignSelf: "stretch",
    borderRadius: 12,
    backgroundColor: theme.bg,
    borderWidth: 1,
    borderColor: theme.inputBorder,
    overflow: "hidden"
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: theme.border
  },
  headerText: {
    color: theme.muted,
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 12
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingHorizontal: 14,
    paddingVertical: 12
  },
  rowDivider: {
    borderTopWidth: 1,
    borderTopColor: theme.border
  },
  swatch: {
    width: 40,
    height: 40,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center"
  },
  textColumn: {
    flex: 1,
    minWidth: 0,
    gap: 3
  },
  filename: {
    color: theme.text,
    fontFamily: family("JetBrainsMono"),
    fontSize: 13
  },
  dir: {
    color: theme.muted,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 12
  }
});
