import { Feather } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import * as FileSystem from "expo-file-system/legacy";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode
} from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
  useWindowDimensions
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Markdown, { MarkdownIt } from "react-native-markdown-display";
import Animated, {
  FadeIn,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { fetchWorkspaceFile, fileRawSource, type WorkspaceFile } from "@/src/api";
import { fileAccent, previewKind } from "@/src/file-accent";
import { parseCsv } from "@/src/parse-csv";
import { family, theme } from "@/src/theme";

// Blue swatch + accent for the previewer's title/header (matches the card's
// doc tint). Kept local since it's specific to this sheet's chrome.
const SWATCH_BG = "#EEF2FF";
const SWATCH_BORDER = "#D7DEFA";
const SWATCH_FG = "#3554D1";

// What the sheet opens against — just the workspace path. The sheet derives
// the filename, directory, and render strategy from it and fetches the bytes
// only while open.
export interface FilePreviewTarget {
  path: string;
}

interface FilePreviewContextValue {
  open: (target: FilePreviewTarget) => void;
}

const FilePreviewContext = createContext<FilePreviewContextValue | null>(null);

export function useFilePreview(): FilePreviewContextValue {
  const ctx = useContext(FilePreviewContext);
  if (!ctx) {
    throw new Error("useFilePreview must be used within a FilePreviewProvider");
  }
  return ctx;
}

// Mounts a single bottom-sheet previewer above the rest of the app and hands
// children an `open()` to summon it for a given workspace path. Mirrors
// ImagePreview's root-overlay pattern so any nested file row can trigger the
// same sheet without per-row state.
export function FilePreviewProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<FilePreviewTarget | null>(null);
  const open = useCallback((next: FilePreviewTarget) => setTarget(next), []);
  const value = useMemo<FilePreviewContextValue>(() => ({ open }), [open]);
  return (
    <FilePreviewContext.Provider value={value}>
      {children}
      {target ? (
        // Key by path so opening a different file remounts with fresh shared
        // values instead of inheriting the last drag offset.
        <FilePreviewSheet
          key={target.path}
          target={target}
          onClose={() => setTarget(null)}
        />
      ) : null}
    </FilePreviewContext.Provider>
  );
}

// Drag-down dismiss thresholds, same heuristic as ImagePreview: a fast
// downward release flings the sheet off, an upward release snaps it back, and
// a near-stationary release falls back to how far it was dragged.
const DISMISS_THRESHOLD = 80;
const RELEASE_SLOP = 120;

function FilePreviewSheet({
  target,
  onClose
}: {
  target: FilePreviewTarget;
  onClose: () => void;
}) {
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const translateY = useSharedValue(0);
  const close = useCallback(() => onClose(), [onClose]);

  // Only the drag handle area drives the dismiss gesture; the body owns its
  // own scroll, so a pan started on the handle won't fight the ScrollView.
  const pan = Gesture.Pan()
    .onUpdate((event) => {
      // Clamp upward drag to 0 — the sheet is already pinned near the top.
      translateY.value = Math.max(0, event.translationY);
    })
    .onEnd((event) => {
      const movingDown = event.velocityY > RELEASE_SLOP;
      const movingUp = event.velocityY < -RELEASE_SLOP;
      const dismiss = movingUp ? false : movingDown ? true : event.translationY > DISMISS_THRESHOLD;
      if (dismiss) {
        translateY.value = withTiming(height, { duration: 220 }, (finished) => {
          if (finished) runOnJS(close)();
        });
      } else {
        translateY.value = withSpring(0, { damping: 22, stiffness: 240 });
      }
    });

  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }]
  }));

  const lastSlash = target.path.lastIndexOf("/");
  const filename = lastSlash >= 0 ? target.path.slice(lastSlash + 1) : target.path;
  const dir = lastSlash > 0 ? target.path.slice(0, lastSlash) : "";

  return (
    <View style={[StyleSheet.absoluteFill, styles.overlay]}>
      <Animated.View
        entering={FadeIn.duration(160)}
        style={[StyleSheet.absoluteFill, styles.backdrop]}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={close} accessibilityLabel="Dismiss" />
      </Animated.View>
      <Animated.View style={[styles.sheet, { top: insets.top + 34 }, sheetStyle]}>
        <GestureDetector gesture={pan}>
          <View style={styles.handleArea}>
            <View style={styles.handle} />
            <SheetHeader filename={filename} dir={dir} onClose={close} />
          </View>
        </GestureDetector>
        <SheetContent path={target.path} filename={filename} bottomInset={insets.bottom} />
      </Animated.View>
    </View>
  );
}

function SheetHeader({
  filename,
  dir,
  onClose
}: {
  filename: string;
  dir: string;
  onClose: () => void;
}) {
  return (
    <View style={styles.header}>
      <Pressable
        onPress={onClose}
        hitSlop={8}
        style={styles.headerIconButton}
        accessibilityRole="button"
        accessibilityLabel="Close"
      >
        <Feather name="x" size={20} color={theme.text} />
      </Pressable>
      <View style={styles.headerTitleGroup}>
        <Text style={styles.headerFilename} numberOfLines={1}>
          {filename}
        </Text>
        <Text style={styles.headerSubtitle} numberOfLines={1}>
          {dir ? `/${dir} · ` : ""}Generated by Gini
        </Text>
      </View>
      <View style={styles.headerIconButton} />
    </View>
  );
}

function SheetContent({
  path,
  filename,
  bottomInset
}: {
  path: string;
  filename: string;
  bottomInset: number;
}) {
  const kind = previewKind(filename);
  const accent = fileAccent(path);
  const dot = filename.lastIndexOf(".");
  const kindLabel = dot > 0 ? filename.slice(dot + 1).toUpperCase() : "File";

  // Images decode straight from the gateway via <Image>; every other kind
  // needs the JSON content read. Skip the query for images so we don't fetch
  // bytes we won't render.
  const { data, isLoading, error } = useQuery({
    queryKey: ["workspace-file", path],
    queryFn: () => fetchWorkspaceFile(path),
    enabled: kind !== "image"
  });

  return (
    <View style={styles.contentWrap}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator
      >
        <View style={styles.titleRow}>
          <View
            style={[styles.titleSwatch, { backgroundColor: SWATCH_BG, borderColor: SWATCH_BORDER }]}
          >
            <Feather name="file-text" size={18} color={SWATCH_FG} />
          </View>
          <View style={styles.titleColumn}>
            <Text style={styles.titleName} numberOfLines={2}>
              {filename}
            </Text>
            <Text style={styles.titleMeta}>{kindLabel} · just now</Text>
          </View>
        </View>
        <View style={styles.hairline} />
        <PreviewBody kind={kind} path={path} filename={filename} data={data} isLoading={isLoading} error={error} accent={accent} />
      </ScrollView>
      <DownloadToolbar path={path} filename={filename} bottomInset={bottomInset} />
    </View>
  );
}

function PreviewBody({
  kind,
  path,
  filename,
  data,
  isLoading,
  error,
  accent
}: {
  kind: ReturnType<typeof previewKind>;
  path: string;
  filename: string;
  data: WorkspaceFile | undefined;
  isLoading: boolean;
  error: unknown;
  accent: { bg: string; fg: string };
}) {
  if (kind === "image") {
    const source = fileRawSource(path, { inline: true });
    return (
      <Image
        source={source}
        style={styles.image}
        resizeMode="contain"
        accessibilityLabel={filename}
      />
    );
  }
  if (kind === "pdf") {
    return <BinaryFallback accent={accent} />;
  }
  if (isLoading) {
    return (
      <View style={styles.bodyCenter}>
        <ActivityIndicator color={theme.muted} />
      </View>
    );
  }
  if (error) {
    return (
      <Text style={styles.errorText}>
        {error instanceof Error ? error.message : "Failed to load file"}
      </Text>
    );
  }
  if (!data) return null;
  if (data.binary) {
    return <BinaryFallback accent={accent} />;
  }
  const content = data.content ?? "";
  if (kind === "markdown") {
    return (
      <View>
        <Markdown style={markdownStyles} markdownit={markdownIt}>
          {content}
        </Markdown>
        {data.truncated ? <Text style={styles.truncated}>[truncated]</Text> : null}
      </View>
    );
  }
  if (kind === "csv") {
    return (
      <CsvTable
        content={content}
        delimiter={filename.toLowerCase().endsWith(".tsv") ? "\t" : ","}
        truncated={data.truncated}
      />
    );
  }
  return (
    <View style={styles.codeBlock}>
      <Text style={styles.codeText}>
        {content}
        {data.truncated ? "\n\n[truncated]" : ""}
      </Text>
    </View>
  );
}

// PDFs and other binary files can't render in-app without a WebView, so the
// sheet shows a tappable-affordance-free notice pointing at the toolbar.
function BinaryFallback({ accent }: { accent: { bg: string; fg: string } }) {
  return (
    <View style={styles.fallback}>
      <View style={[styles.fallbackSwatch, { backgroundColor: accent.bg }]}>
        <Feather name="file" size={22} color={accent.fg} />
      </View>
      <Text style={styles.fallbackText}>
        Can&apos;t preview this file type here — use Download or Share to open it.
      </Text>
    </View>
  );
}

function CsvTable({
  content,
  delimiter,
  truncated
}: {
  content: string;
  delimiter: string;
  truncated: boolean;
}) {
  if (!content.trim()) {
    return <Text style={styles.errorText}>Empty file.</Text>;
  }
  const rows = parseCsv(content, delimiter);
  const header = rows[0] ?? [];
  const body = rows.slice(1);
  return (
    <View>
      <ScrollView horizontal showsHorizontalScrollIndicator style={styles.tableScroll}>
        <View style={styles.table}>
          <View style={[styles.tableRow, styles.tableHeaderRow]}>
            {header.map((cell, c) => (
              <Text key={c} style={[styles.tableCell, styles.tableHeaderCell]}>
                {cell}
              </Text>
            ))}
          </View>
          {body.map((row, r) => (
            <View key={r} style={[styles.tableRow, styles.tableBodyRow]}>
              {row.map((cell, c) => (
                <Text key={c} style={styles.tableCell}>
                  {cell}
                </Text>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
      {truncated ? <Text style={styles.truncated}>[truncated]</Text> : null}
    </View>
  );
}

function DownloadToolbar({
  path,
  filename,
  bottomInset
}: {
  path: string;
  filename: string;
  bottomInset: number;
}) {
  const [busy, setBusy] = useState(false);

  // Download (and Share) both pull the raw bytes to a local cache file first,
  // then hand it to the OS share sheet — iOS exposes "Save to Files" there,
  // which is the download mechanism on a phone. No new native deps: RN core
  // Share + the bundled expo-file-system. Errors surface via Alert.
  const run = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const { uri, headers } = fileRawSource(path);
      const safeName = filename.replace(/[^A-Za-z0-9._-]/g, "_") || "file";
      const dest = `${FileSystem.cacheDirectory}${safeName}`;
      const result = await FileSystem.downloadAsync(uri, dest, { headers });
      await Share.share({ url: result.uri });
    } catch (err) {
      Alert.alert("Download failed", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [busy, path, filename]);

  return (
    <View style={[styles.toolbar, { paddingBottom: 14 + bottomInset }]}>
      <Pressable
        onPress={run}
        disabled={busy}
        style={[styles.downloadPill, busy && styles.downloadPillBusy]}
        accessibilityRole="button"
        accessibilityLabel="Download"
      >
        {busy ? (
          <ActivityIndicator color={theme.buttonText} />
        ) : (
          <>
            <Feather name="download" size={16} color={theme.buttonText} />
            <Text style={styles.downloadText}>Download</Text>
          </>
        )}
      </Pressable>
      <Pressable
        onPress={run}
        disabled={busy}
        style={styles.shareButton}
        accessibilityRole="button"
        accessibilityLabel="Share"
      >
        <Feather name="share" size={18} color={theme.text} />
      </Pressable>
    </View>
  );
}

// Same MarkdownIt config as the chat bubble (autolink bare URLs, typographer).
const markdownIt = MarkdownIt({ typographer: true, linkify: true });

const styles = StyleSheet.create({
  overlay: {
    zIndex: 1000,
    elevation: 1000
  },
  backdrop: {
    backgroundColor: "rgba(0,0,0,0.4)"
  },
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: theme.bg,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    overflow: "hidden"
  },
  handleArea: {
    paddingTop: 8
  },
  handle: {
    alignSelf: "center",
    width: 40,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: "#C7C7CC"
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: theme.border
  },
  headerIconButton: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center"
  },
  headerTitleGroup: {
    flex: 1,
    alignItems: "center",
    paddingHorizontal: 8
  },
  headerFilename: {
    color: theme.text,
    fontFamily: family("JetBrainsMono"),
    fontSize: 15
  },
  headerSubtitle: {
    color: theme.muted,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 11,
    marginTop: 2
  },
  contentWrap: {
    flex: 1
  },
  scroll: {
    flex: 1
  },
  scrollContent: {
    paddingHorizontal: 20,
    paddingTop: 24,
    paddingBottom: 24
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12
  },
  titleSwatch: {
    width: 40,
    height: 40,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center"
  },
  titleColumn: {
    flex: 1,
    minWidth: 0
  },
  titleName: {
    color: theme.text,
    fontFamily: family("HankenGrotesk", 700),
    fontSize: 24
  },
  titleMeta: {
    color: theme.muted,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 12,
    marginTop: 2
  },
  hairline: {
    height: 1,
    backgroundColor: theme.border,
    marginVertical: 16
  },
  bodyCenter: {
    paddingVertical: 32,
    alignItems: "center"
  },
  errorText: {
    color: theme.danger,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 13
  },
  truncated: {
    color: theme.muted,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 12,
    marginTop: 8
  },
  image: {
    width: "100%",
    height: 320,
    borderRadius: 8
  },
  codeBlock: {
    backgroundColor: theme.codeChipBg,
    borderRadius: 8,
    padding: 12
  },
  codeText: {
    color: theme.codeChipText,
    fontFamily: family("JetBrainsMono"),
    fontSize: 13,
    lineHeight: 19
  },
  fallback: {
    alignItems: "center",
    gap: 12,
    paddingVertical: 24
  },
  fallbackSwatch: {
    width: 48,
    height: 48,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center"
  },
  fallbackText: {
    color: theme.subtle,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 14,
    textAlign: "center",
    maxWidth: 280
  },
  tableScroll: {
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 10
  },
  table: {
    minWidth: "100%"
  },
  tableRow: {
    flexDirection: "row"
  },
  tableHeaderRow: {
    backgroundColor: theme.codeChipBg
  },
  tableBodyRow: {
    borderTopWidth: 1,
    borderTopColor: theme.border
  },
  tableCell: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    minWidth: 96,
    color: theme.text,
    fontFamily: family("JetBrainsMono"),
    fontSize: 12
  },
  tableHeaderCell: {
    color: theme.subtle,
    fontFamily: family("HankenGrotesk", 700)
  },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: theme.border,
    backgroundColor: theme.bg
  },
  downloadPill: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    height: 48,
    borderRadius: 999,
    backgroundColor: theme.button
  },
  downloadPillBusy: {
    opacity: 0.7
  },
  downloadText: {
    color: theme.buttonText,
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 16
  },
  shareButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: theme.inputBorder
  }
});

// react-native-markdown-display style map for the white sheet surface. Mirrors
// BlockAssistantText's font choices (Hanken for prose, JetBrains Mono for
// code) but on the chat's primary text color rather than the bubble color.
const markdownStyles = StyleSheet.create({
  body: {
    color: theme.text,
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 15,
    lineHeight: 22
  },
  paragraph: {
    color: theme.text,
    fontFamily: family("HankenGrotesk", 500),
    marginTop: 0,
    marginBottom: 8
  },
  heading1: {
    color: theme.text,
    fontFamily: family("HankenGrotesk", 700),
    fontSize: 22,
    marginTop: 8,
    marginBottom: 6
  },
  heading2: {
    color: theme.text,
    fontFamily: family("HankenGrotesk", 700),
    fontSize: 19,
    marginTop: 8,
    marginBottom: 6
  },
  heading3: {
    color: theme.text,
    fontFamily: family("HankenGrotesk", 700),
    fontSize: 16,
    marginTop: 8,
    marginBottom: 6
  },
  heading4: {
    color: theme.text,
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 15,
    marginTop: 8,
    marginBottom: 6
  },
  heading5: {
    color: theme.text,
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 14,
    marginTop: 8,
    marginBottom: 6
  },
  heading6: {
    color: theme.text,
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 13,
    marginTop: 8,
    marginBottom: 6
  },
  strong: {
    color: theme.text,
    fontFamily: family("HankenGrotesk", 700)
  },
  em: {
    color: theme.text,
    fontStyle: "italic"
  },
  link: { color: theme.accent, textDecorationLine: "underline" },
  blockquote: {
    backgroundColor: theme.codeChipBg,
    borderLeftColor: theme.accent,
    borderLeftWidth: 3,
    paddingLeft: 8,
    paddingVertical: 4,
    marginVertical: 4
  },
  code_inline: {
    backgroundColor: theme.codeChipBg,
    color: theme.codeChipText,
    paddingHorizontal: 4,
    borderRadius: 4,
    fontFamily: family("JetBrainsMono"),
    fontSize: 13
  },
  code_block: {
    backgroundColor: theme.codeChipBg,
    color: theme.codeChipText,
    padding: 8,
    borderRadius: 6,
    fontFamily: family("JetBrainsMono"),
    fontSize: 13
  },
  fence: {
    backgroundColor: theme.codeChipBg,
    color: theme.codeChipText,
    padding: 8,
    borderRadius: 6,
    fontFamily: family("JetBrainsMono"),
    fontSize: 13,
    borderWidth: 0
  },
  bullet_list: { marginVertical: 4 },
  ordered_list: { marginVertical: 4 },
  list_item: {
    color: theme.text,
    fontFamily: family("HankenGrotesk", 500),
    marginVertical: 2
  },
  hr: {
    backgroundColor: theme.border,
    height: 1,
    marginVertical: 8
  },
  table: { borderColor: theme.border },
  thead: { borderColor: theme.border, backgroundColor: theme.codeChipBg },
  th: {
    color: theme.text,
    fontFamily: family("HankenGrotesk", 700),
    padding: 6
  },
  tbody: { borderColor: theme.border },
  td: {
    color: theme.text,
    fontFamily: family("HankenGrotesk", 500),
    padding: 6,
    borderColor: theme.border
  }
});
