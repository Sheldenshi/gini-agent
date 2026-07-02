import { describe, expect, mock, test } from "bun:test";

// uploadAttachment.ts imports react-native (Flow syntax — unparseable by bun),
// expo-file-system/legacy, and @/src/api (pulls expo-file-system at import).
// Stub all three so the module graph resolves. Most tests inject deps, but one
// drives the DEFAULT-deps path (defaultDeps factory) through these spies so the
// production wiring (uploadRawSource → FileSystem → Share/Alert) is covered.
const rnShare = mock((_c: { url?: string; message?: string; title?: string }) => Promise.resolve(null));
const rnAlert = mock((_t: string, _m?: string) => {});
const fsDownload = mock((_uri: string, dest: string) => Promise.resolve({ uri: `file://${dest}` }));
const apiSource = mock((id: string) => ({ uri: `https://gw/api/uploads/${id}`, headers: { authorization: "Bearer real" } }));
const apiSign = mock((id: string) => Promise.resolve(`https://gw/api/uploads/${id}?inline=1&exp=9&sig=ab`));
const linkOpen = mock((_url: string) => {});
mock.module("react-native", () => ({
  Platform: { OS: "ios" },
  Share: { share: rnShare },
  Alert: { alert: rnAlert }
}));
mock.module("expo-file-system/legacy", () => ({
  cacheDirectory: "/cache/",
  downloadAsync: fsDownload
}));
mock.module("@/src/api", () => ({ uploadRawSource: apiSource, signUploadUrl: apiSign }));
// linkContextMenu pulls expo-web-browser / clipboard at import; stub openLink.
mock.module("./linkContextMenu", () => ({ openLink: linkOpen }));

const { openUploadAttachment, openUploadInBrowser, safeAttachmentName } = await import("./uploadAttachment");
type UploadAttachmentDeps = import("./uploadAttachment").UploadAttachmentDeps;
type OpenInBrowserDeps = import("./uploadAttachment").OpenInBrowserDeps;

// Build a deps bundle with spies so the orchestration is exercised without the
// native FileSystem/Share/Alert bridges. Each field is overridable per test.
function makeDeps(overrides: Partial<UploadAttachmentDeps> = {}): {
  deps: UploadAttachmentDeps;
  calls: {
    download: ReturnType<typeof mock>;
    share: ReturnType<typeof mock>;
    alert: ReturnType<typeof mock>;
    source: ReturnType<typeof mock>;
  };
} {
  const download = mock((_uri: string, dest: string, _opts: { headers: Record<string, string> }) =>
    Promise.resolve({ uri: `file://${dest}` })
  );
  const share = mock((_content: { url?: string; message?: string; title?: string }) => Promise.resolve(null));
  const alert = mock((_t: string, _m: string) => {});
  const source = mock((id: string) => ({
    uri: `https://gw.example/api/uploads/${id}`,
    headers: { authorization: "Bearer t", "X-Device-Token": "dev" }
  }));
  const deps: UploadAttachmentDeps = {
    source: source as unknown as UploadAttachmentDeps["source"],
    cacheDir: "/cache/",
    download,
    share,
    platformOS: "ios",
    alert,
    ...overrides
  };
  return { deps, calls: { download, share, alert, source } };
}

describe("safeAttachmentName", () => {
  test("keeps safe chars and replaces the rest", () => {
    expect(safeAttachmentName("report.pdf")).toBe("report.pdf");
    expect(safeAttachmentName("my notes (1).md")).toBe("my_notes__1_.md");
    expect(safeAttachmentName("../../etc/passwd")).toBe(".._.._etc_passwd");
  });

  test("unsafe chars become underscores; an empty name falls back to 'file'", () => {
    // Mirrors the file-preview Download toolbar: replace then `|| "file"`, so a
    // name that maps to all-underscores stays underscores (still a valid name)
    // and only a truly empty string falls back.
    expect(safeAttachmentName("###")).toBe("___");
    expect(safeAttachmentName("")).toBe("file");
  });
});

describe("openUploadAttachment", () => {
  test("downloads with the bearer headers then shares the local file on iOS", async () => {
    const { deps, calls } = makeDeps({ platformOS: "ios" });
    await openUploadAttachment("up_1", "report.pdf", deps);
    expect(calls.source).toHaveBeenCalledWith("up_1");
    // The cache dest is namespaced by upload id so two same-named uploads can't
    // collide / overwrite each other's bytes.
    expect(calls.download).toHaveBeenCalledWith(
      "https://gw.example/api/uploads/up_1",
      "/cache/up_1-report.pdf",
      { headers: { authorization: "Bearer t", "X-Device-Token": "dev" } }
    );
    // iOS shares via { url } so the share sheet exposes Quick Look + Save to Files.
    expect(calls.share).toHaveBeenCalledWith({ url: "file:///cache/up_1-report.pdf" });
    expect(calls.alert).not.toHaveBeenCalled();
  });

  test("on Android shares via message+title (RN Share can't attach a file there)", async () => {
    const { deps, calls } = makeDeps({ platformOS: "android" });
    await openUploadAttachment("up_2", "data.csv", deps);
    expect(calls.share).toHaveBeenCalledWith({ message: "file:///cache/up_2-data.csv", title: "data.csv" });
  });

  test("a null cache dir degrades to an id-namespaced bare filename dest", async () => {
    const { deps, calls } = makeDeps({ cacheDir: null });
    await openUploadAttachment("up_3", "x.md", deps);
    expect(calls.download).toHaveBeenCalledWith(
      "https://gw.example/api/uploads/up_3",
      "up_3-x.md",
      { headers: { authorization: "Bearer t", "X-Device-Token": "dev" } }
    );
  });

  test("a download failure surfaces an Alert, not an unhandled rejection", async () => {
    const { deps, calls } = makeDeps({
      download: mock(() => Promise.reject(new Error("network down")))
    });
    await openUploadAttachment("up_4", "report.pdf", deps);
    expect(calls.alert).toHaveBeenCalledWith("Couldn't open attachment", "network down");
    expect(calls.share).not.toHaveBeenCalled();
  });

  test("a non-Error throw is stringified into the Alert", async () => {
    const { deps, calls } = makeDeps({
      source: mock(() => {
        throw "no creds";
      }) as unknown as UploadAttachmentDeps["source"]
    });
    await openUploadAttachment("up_5", "report.pdf", deps);
    expect(calls.alert).toHaveBeenCalledWith("Couldn't open attachment", "no creds");
  });

  test("with no injected deps, the default wiring threads through the real bridges", async () => {
    // Exercises the defaultDeps factory: uploadRawSource → FileSystem cache +
    // downloadAsync → Share, via the module-level mocks installed above.
    await openUploadAttachment("up_default", "guide.md");
    expect(apiSource).toHaveBeenCalledWith("up_default");
    expect(fsDownload).toHaveBeenCalledWith(
      "https://gw/api/uploads/up_default",
      "/cache/up_default-guide.md",
      { headers: { authorization: "Bearer real" } }
    );
    expect(rnShare).toHaveBeenCalledWith({ url: "file:///cache/up_default-guide.md" });
    expect(rnAlert).not.toHaveBeenCalled();
  });

  test("with no injected deps, a failure routes through the real Alert wrapper", async () => {
    // Drives the default-deps ERROR path so the `Alert.alert` wrapper inside
    // defaultDeps is exercised (not just the injected alert spy).
    rnAlert.mockClear();
    fsDownload.mockImplementationOnce(() => Promise.reject(new Error("disk full")));
    await openUploadAttachment("up_defaulterr", "guide.md");
    expect(rnAlert).toHaveBeenCalledWith("Couldn't open attachment", "disk full");
  });
});

describe("openUploadInBrowser", () => {
  function makeBrowserDeps(overrides: Partial<OpenInBrowserDeps> = {}): {
    deps: OpenInBrowserDeps;
    calls: { sign: ReturnType<typeof mock>; open: ReturnType<typeof mock>; fallback: ReturnType<typeof mock> };
  } {
    const sign = mock((id: string) => Promise.resolve(`https://gw/api/uploads/${id}?inline=1&exp=9&sig=ab`));
    const open = mock((_url: string) => {});
    const fallback = mock((_id: string, _f: string) => Promise.resolve());
    const deps: OpenInBrowserDeps = {
      sign: sign as unknown as OpenInBrowserDeps["sign"],
      open,
      fallback,
      ...overrides
    };
    return { deps, calls: { sign, open, fallback } };
  }

  test("mints a signed url and opens it in the in-app browser", async () => {
    const { deps, calls } = makeBrowserDeps();
    await openUploadInBrowser("up_1", "report.pdf", deps);
    expect(calls.sign).toHaveBeenCalledWith("up_1");
    expect(calls.open).toHaveBeenCalledWith("https://gw/api/uploads/up_1?inline=1&exp=9&sig=ab");
    expect(calls.fallback).not.toHaveBeenCalled();
  });

  test("falls back to download/share when minting fails", async () => {
    const { deps, calls } = makeBrowserDeps({
      sign: mock(() => Promise.reject(new Error("offline"))) as unknown as OpenInBrowserDeps["sign"]
    });
    await openUploadInBrowser("up_2", "report.pdf", deps);
    expect(calls.open).not.toHaveBeenCalled();
    expect(calls.fallback).toHaveBeenCalledWith("up_2", "report.pdf");
  });

  test("with no injected deps, the default wiring signs and opens via openLink", async () => {
    apiSign.mockClear();
    linkOpen.mockClear();
    await openUploadInBrowser("up_default", "guide.md");
    expect(apiSign).toHaveBeenCalledWith("up_default");
    expect(linkOpen).toHaveBeenCalledWith("https://gw/api/uploads/up_default?inline=1&exp=9&sig=ab");
  });

  test("with no injected deps, a mint failure falls back to the real download path", async () => {
    apiSign.mockImplementationOnce(() => Promise.reject(new Error("gateway 500")));
    fsDownload.mockClear();
    await openUploadInBrowser("up_defaulterr", "guide.md");
    // Default fallback === openUploadAttachment → downloads with the bearer.
    expect(fsDownload).toHaveBeenCalledWith(
      "https://gw/api/uploads/up_defaulterr",
      "/cache/up_defaulterr-guide.md",
      { headers: { authorization: "Bearer real" } }
    );
  });

  test("two same-named uploads get DISTINCT cache dests (no collision)", async () => {
    const { deps, calls } = makeDeps({ platformOS: "ios" });
    await openUploadAttachment("up_aaa", "report.pdf", deps);
    await openUploadAttachment("up_bbb", "report.pdf", deps);
    const dests = calls.download.mock.calls.map((c) => c[1]);
    expect(dests).toEqual(["/cache/up_aaa-report.pdf", "/cache/up_bbb-report.pdf"]);
    expect(new Set(dests).size).toBe(2);
  });
});
