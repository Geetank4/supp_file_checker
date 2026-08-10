import { useState, useRef, useCallback } from "react";

// ── Keyword taxonomy ──────────────────────────────────────────────────────────
const TERM_GROUPS = [
  { label: "Additional File",              covers: ["additional file", "additional files"] },
  { label: "Appendices",                   covers: ["appendices"] },
  { label: "Appendix",                     covers: ["appendix", "eappendix", "web appendix", "supplementary appendix", "supplemental appendix", "online appendix", "internet appendix"] },
  { label: "Data File",                    covers: ["data file", "data files"] },
  { label: "eFigure",                      covers: ["efigure", "efigures", "e-figure", "e-figures"] },
  { label: "eTable",                       covers: ["etable", "etables", "e-table", "e-tables"] },
  { label: "Online Material",              covers: ["online supplement", "online-only material", "online only material", "web supplement", "web-only material"] },
  { label: "Supplement",                   covers: ["electronic supplementary material", "esm", "supplemental digital content", "sdc", "data supplement", "supplementary material", "supplementary materials", "supplemental material", "supplemental materials", "supplementary data", "supplementary information", "supplemental information"] },
  { label: "Supporting",                   covers: ["supporting information", "supporting documents", "supporting material", "supporting materials", "supporting data"] },
  { label: "Supplementary Figure",        covers: ["supplementary figure", "supplementary figures", "supplemental figure", "supplemental figures", "suppl. figure", "suppl figure", "supp. figure"] },
  { label: "Supplementary Table",         covers: ["supplementary table", "supplementary tables", "supplemental table", "supplemental tables", "suppl. table", "suppl table", "supp. table"] },
  { label: "Supplementary Methods",       covers: ["supplementary methods", "supplemental methods", "supplementary methodology", "supplementary statistical methods"] },
  { label: "eMethods",                     covers: ["emethods", "emethod", "e-methods", "e-method"] },
  { label: "eResults / eDiscussion",      covers: ["eresults", "eresult", "e-results", "ediscussion", "e-discussion"] },
  { label: "Extended Data",               covers: ["extended data"] },
  { label: "Source Data",                 covers: ["source data", "source datasets"] },
  { label: "Supplementary File",          covers: ["supplementary file", "supplementary files", "supplemental file", "supplemental files"] },
  { label: "Supplementary Protocol",      covers: ["supplementary protocol", "supplemental protocol"] },
  { label: "Supplementary Video",         covers: ["supplementary video", "supplementary videos", "supplemental video", "supplemental videos"] },
  { label: "Supplementary Results/Notes", covers: ["supplementary results", "supplemental results", "supplementary notes", "supplementary text", "supplementary discussion", "supplementary analysis"] },
  { label: "Supplementary Box/Exhibit",   covers: ["supplementary box", "supplemental box", "supplementary exhibit"] },
  { label: "Abbreviated Refs (S1, Fig S…)",covers: ["table s", "figure s", "fig. s", "fig s", "s1 table", "s1 figure", "s appendix", "s1 appendix"] },
];

// Abbreviated reference patterns (e.g. Table S1, Figure S2, eFig3)
const ABBREV_PATTERNS = [
  /\bTable\s+S\d+[a-z]?\b/gi,
  /\bFigure\s+S\d+[a-z]?\b/gi,
  /\bFig\.\s*S\d+[a-z]?\b/gi,
  /\bFig\s+S\d+[a-z]?\b/gi,
  /\bS\d+\s+Table\b/gi,
  /\bS\d+\s+Figure\b/gi,
  /\bS\d+\s+Fig\b/gi,
  /\beFig(?:ure)?\s*\d+[a-z]?\b/gi,
  /\beTab(?:le)?\s*\d+[a-z]?\b/gi,
  /\beMethod\b/gi,
  /\bSuppl?\.\s*Fig(?:ure)?\s*\d+\b/gi,
  /\bSuppl?\.\s*Table\s*\d+\b/gi,
];

// Known section headers to detect which part of the article a match is in
const SECTION_HEADERS = [
  "abstract", "introduction", "background", "methods", "materials and methods",
  "patients and methods", "study design", "statistical analysis", "results",
  "findings", "discussion", "conclusion", "conclusions", "limitations",
  "references", "acknowledgements", "acknowledgments", "funding",
  "supplementary", "appendix",
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function detectSection(text, index) {
  const before = text.slice(Math.max(0, index - 5000), index).toLowerCase();
  let lastSection = "Body";
  let lastPos = -1;
  for (const header of SECTION_HEADERS) {
    const pos = before.lastIndexOf(header);
    if (pos > lastPos) {
      lastPos = pos;
      lastSection = header.charAt(0).toUpperCase() + header.slice(1);
    }
  }
  return lastSection;
}

// ── PDF extraction (pdfjs-dist, loaded dynamically) ───────────────────────────
async function extractTextFromPDF(file) {
  // Dynamic import avoids SSR issues in Next.js
  const pdfjsLib = await import("pdfjs-dist");

  // Worker served from public/ (copied via postinstall — no CDN needed)
  pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.js";

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  let fullText = "";
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    // Join items; insert spaces between words that pdf.js sometimes omits
    const pageText = content.items
      .map((item) => item.str)
      .join(" ")
      .replace(/\s{2,}/g, " ");
    fullText += pageText + "\n";
  }
  return fullText;
}

// ── Core analysis (pure regex, no AI) ────────────────────────────────────────

// These short abbreviations are often used in compact form with no space before
// a digit — e.g. SDC1, ESM2 — which breaks standard \b word boundaries.
// We allow an optional trailing digit sequence for these terms only.
const TRAILING_DIGIT_TERMS = new Set(["sdc", "esm", "sm", "sdm"]);

function analyzeText(fullText) {
  const mentions = [];
  const categories = new Set();
  const abbreviatedRefSet = new Set();
  const seenPositions = new Set();

  for (const group of TERM_GROUPS) {
    for (const term of group.covers) {
      const escaped = escapeRegex(term);
      const allowTrailingDigit = TRAILING_DIGIT_TERMS.has(term.toLowerCase());
      // Use word boundary only when the term starts/ends with a letter;
      // for known abbreviations, allow optional trailing digits (SDC1, ESM2 …)
      const pattern = /^[a-zA-Z]/.test(term)
        ? `\\b${escaped}${allowTrailingDigit ? "\\d*" : ""}\\b`
        : escaped;
      const regex = new RegExp(pattern, "gi");
      let match;
      while ((match = regex.exec(fullText)) !== null) {
        if (seenPositions.has(match.index)) continue;
        seenPositions.add(match.index);

        const ctxStart = Math.max(0, match.index - 130);
        const ctxEnd = Math.min(fullText.length, match.index + match[0].length + 130);
        const context = fullText.slice(ctxStart, ctxEnd).replace(/\s+/g, " ").trim();
        const section = detectSection(fullText, match.index);

        mentions.push({ term: match[0], category: group.label, section, context });
        categories.add(group.label);
      }
    }
  }

  // Abbreviated refs (Table S1, Fig. S3, eFig 2 …)
  for (const pattern of ABBREV_PATTERNS) {
    const found = fullText.match(pattern) || [];
    found.forEach((r) => abbreviatedRefSet.add(r.replace(/\s+/g, " ").trim()));
  }

  const abbreviatedRefs = [...abbreviatedRefSet];
  const totalMentions = mentions.length;
  const found = totalMentions > 0 || abbreviatedRefs.length > 0;

  const summary = found
    ? `Found ${totalMentions} keyword mention${totalMentions !== 1 ? "s" : ""} across ${categories.size} categor${categories.size === 1 ? "y" : "ies"}${abbreviatedRefs.length ? `, plus ${abbreviatedRefs.length} abbreviated reference${abbreviatedRefs.length !== 1 ? "s" : ""}` : ""}.`
    : "No references to supplementary material detected in this PDF.";

  return {
    found,
    totalMentions,
    summary,
    categories: [...categories],
    mentions,
    abbreviatedRefs,
    additionalObservations: null,
  };
}

// ── FileRow component ─────────────────────────────────────────────────────────
function FileRow({ item, onRemove }) {
  const [open, setOpen] = useState(false);
  const { file, status, results, error } = item;
  const mentions = results?.mentions || [];
  const abbrev = results?.abbreviatedRefs || [];
  const count = results?.totalMentions ?? mentions.length ?? 0;

  const STATUS = {
    idle:      { dot: "#94a3b8", label: "Pending",    labelColor: "#64748b", bg: "#f1f5f9" },
    analyzing: { dot: "#f59e0b", label: "Reading…",   labelColor: "#b45309", bg: "#fef3c7" },
    done:      {
      dot: results?.found ? "#22c55e" : "#94a3b8",
      label: results?.found ? `${count} found` : "None found",
      labelColor: results?.found ? "#15803d" : "#64748b",
      bg: results?.found ? "#dcfce7" : "#f1f5f9",
    },
    error:     { dot: "#ef4444", label: "Error",      labelColor: "#dc2626", bg: "#fee2e2" },
  };
  const s = STATUS[status] || STATUS.idle;

  return (
    <div style={{ background: "white", border: "1px solid #e2e8f0", borderRadius: 12, marginBottom: 10, overflow: "hidden", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
      {/* Row */}
      <div style={{ display: "flex", alignItems: "center", padding: "13px 18px", gap: 12 }}>
        <span style={{ fontSize: 18, flexShrink: 0 }}>📄</span>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, color: "#0f172a", fontSize: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{file.name}</div>
          <div style={{ color: "#94a3b8", fontSize: 12, marginTop: 1 }}>{(file.size / 1024).toFixed(0)} KB</div>
        </div>

        {/* Status badge */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, background: s.bg, borderRadius: 20, padding: "5px 12px", flexShrink: 0 }}>
          <div style={{ width: 7, height: 7, borderRadius: "50%", background: s.dot, animation: status === "analyzing" ? "pulse 1s ease-in-out infinite" : "none" }} />
          <span style={{ fontSize: 12, fontWeight: 700, color: s.labelColor }}>{s.label}</span>
        </div>

        {/* Expand */}
        {status === "done" && results?.found && (
          <button onClick={() => setOpen((o) => !o)}
            style={{ background: "none", border: "1px solid #e2e8f0", borderRadius: 8, padding: "6px 14px", cursor: "pointer", fontSize: 12, fontWeight: 600, color: "#475569", flexShrink: 0 }}>
            {open ? "▲ Collapse" : "▼ Details"}
          </button>
        )}

        {/* Remove */}
        {status !== "analyzing" && (
          <button onClick={onRemove}
            style={{ background: "none", border: "none", cursor: "pointer", color: "#cbd5e1", fontSize: 20, padding: "0 2px", lineHeight: 1, flexShrink: 0, fontWeight: 300 }}>
            ×
          </button>
        )}
      </div>

      {/* Scan line */}
      {status === "analyzing" && (
        <div style={{ height: 2, background: "#f1f5f9", overflow: "hidden" }}>
          <div style={{ height: "100%", width: "40%", background: "linear-gradient(90deg, transparent, #3b82f6, transparent)", animation: "scan 1.4s ease-in-out infinite" }} />
        </div>
      )}

      {/* Error */}
      {status === "error" && (
        <div style={{ padding: "0 18px 13px", color: "#dc2626", fontSize: 13 }}>{error || "Analysis failed. Please try again."}</div>
      )}

      {/* Expanded detail */}
      {open && status === "done" && results?.found && (
        <div style={{ borderTop: "1px solid #f1f5f9", padding: "18px 20px" }}>
          {results.summary && (
            <p style={{ margin: "0 0 14px", color: "#475569", fontSize: 13, lineHeight: 1.6 }}>{results.summary}</p>
          )}

          {/* Category chips */}
          {results.categories?.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 16 }}>
              {results.categories.map((c, i) => (
                <span key={i} style={{ background: "#eff6ff", color: "#1d4ed8", border: "1px solid #bfdbfe", borderRadius: 20, padding: "3px 12px", fontSize: 12, fontWeight: 600 }}>{c}</span>
              ))}
            </div>
          )}

          {/* Mentions table */}
          {mentions.length > 0 && (
            <div style={{ border: "1px solid #e2e8f0", borderRadius: 10, overflow: "hidden", marginBottom: abbrev.length ? 14 : 0 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ background: "#f8fafc" }}>
                    {["#", "Term", "Category", "Section", "Context"].map((h, i) => (
                      <th key={h} style={{ padding: "9px 14px", textAlign: "left", color: "#94a3b8", fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, borderBottom: "1px solid #e2e8f0", width: i === 0 ? 32 : i === 4 ? "auto" : 130 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {mentions.map((m, i) => (
                    <tr key={i} style={{ borderBottom: i < mentions.length - 1 ? "1px solid #f8fafc" : "none" }}>
                      <td style={{ padding: "10px 14px", color: "#cbd5e1", fontWeight: 700 }}>{i + 1}</td>
                      <td style={{ padding: "10px 14px" }}>
                        <span style={{ background: "#ede9fe", color: "#5b21b6", padding: "2px 9px", borderRadius: 20, fontSize: 11, fontWeight: 700 }}>{m.term}</span>
                      </td>
                      <td style={{ padding: "10px 14px", color: "#64748b" }}>{m.category}</td>
                      <td style={{ padding: "10px 14px", color: "#94a3b8" }}>{m.section}</td>
                      <td style={{ padding: "10px 14px", color: "#334155", fontStyle: "italic", lineHeight: 1.6 }}>"{m.context}"</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Abbreviated refs */}
          {abbrev.length > 0 && (
            <div>
              <p style={{ margin: "0 0 8px", fontSize: 12, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: 0.5 }}>Abbreviated refs detected</p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
                {abbrev.map((r, i) => (
                  <span key={i} style={{ background: "#f0f9ff", border: "1px solid #bae6fd", borderRadius: 6, padding: "4px 12px", fontFamily: "monospace", fontSize: 12, color: "#0369a1", fontWeight: 700 }}>{r}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main app ──────────────────────────────────────────────────────────────────
export default function SuppChecker() {
  const [files, setFiles] = useState([]);
  const [dragging, setDragging] = useState(false);
  const [running, setRunning] = useState(false);
  const [showKw, setShowKw] = useState(false);
  const fileRef = useRef();

  const addFiles = useCallback((incoming) => {
    const pdfs = Array.from(incoming).filter((f) => f.type === "application/pdf");
    setFiles((prev) => {
      const existingNames = new Set(prev.map((i) => i.file.name));
      const fresh = pdfs
        .filter((f) => !existingNames.has(f.name))
        .map((f) => ({ id: Math.random().toString(36).slice(2), file: f, status: "idle", results: null, error: null }));
      return [...prev, ...fresh].slice(0, 10);
    });
  }, []);

  const removeFile = useCallback((id) => setFiles((prev) => prev.filter((i) => i.id !== id)), []);

  const analyzeAll = async () => {
    if (running) return;
    const pending = files.filter((i) => i.status === "idle" || i.status === "error");
    if (!pending.length) return;
    setRunning(true);

    for (const item of pending) {
      setFiles((prev) => prev.map((i) => i.id === item.id ? { ...i, status: "analyzing", error: null } : i));
      try {
        const fullText = await extractTextFromPDF(item.file);
        const results = analyzeText(fullText);
        setFiles((prev) => prev.map((i) => i.id === item.id ? { ...i, status: "done", results } : i));
      } catch (e) {
        setFiles((prev) => prev.map((i) => i.id === item.id ? { ...i, status: "error", error: e.message } : i));
      }
    }
    setRunning(false);
  };

  // Stats
  const done      = files.filter((i) => i.status === "done").length;
  const errors    = files.filter((i) => i.status === "error").length;
  const pending   = files.filter((i) => i.status === "idle" || i.status === "error").length;
  const totalFound = files
    .filter((i) => i.status === "done" && i.results?.found)
    .reduce((a, i) => a + (i.results?.totalMentions ?? 0), 0);

  return (
    <div style={{ fontFamily: "'Inter', system-ui, -apple-system, sans-serif", background: "#f1f5f9", minHeight: "100vh" }}>
      <style>{`
        @keyframes scan  { 0%{transform:translateX(-150%)} 100%{transform:translateX(400%)} }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.35} }
      `}</style>

      {/* ── Nav ── */}
      <nav style={{ background: "white", borderBottom: "1px solid #e2e8f0", position: "sticky", top: 0, zIndex: 10 }}>
        <div style={{ maxWidth: 860, margin: "0 auto", padding: "0 24px", height: 58, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 30, height: 30, background: "#1d4ed8", borderRadius: 7, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15 }}>🔍</div>
            <span style={{ fontWeight: 800, fontSize: 16, color: "#0f172a", letterSpacing: -0.3 }}>SuppCheck</span>
            <span style={{ background: "#eff6ff", color: "#1d4ed8", border: "1px solid #bfdbfe", borderRadius: 20, padding: "2px 9px", fontSize: 11, fontWeight: 700 }}>SLR Tool</span>
          </div>
          <button onClick={() => setShowKw((s) => !s)}
            style={{ background: "none", border: "1px solid #e2e8f0", borderRadius: 8, padding: "6px 14px", cursor: "pointer", fontSize: 13, color: "#64748b", fontWeight: 600 }}>
            {showKw ? "Hide" : "View"} keyword list
          </button>
        </div>
      </nav>

      <div style={{ maxWidth: 860, margin: "0 auto", padding: "32px 24px" }}>

        {/* ── Hero ── */}
        <div style={{ marginBottom: 28 }}>
          <h1 style={{ margin: "0 0 8px", fontSize: 26, fontWeight: 800, color: "#0f172a", letterSpacing: -0.5 }}>
            Supplementary File Checker
          </h1>
          <p style={{ margin: 0, color: "#64748b", fontSize: 15, lineHeight: 1.6 }}>
            Upload research article PDFs to detect all references to supplementary content — runs entirely in your browser, no data sent anywhere.
          </p>
        </div>

        {/* ── Upload zone ── */}
        <div
          onDrop={(e) => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); }}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onClick={() => fileRef.current.click()}
          style={{
            background: dragging ? "#eff6ff" : "white",
            border: `2px dashed ${dragging ? "#3b82f6" : "#cbd5e1"}`,
            borderRadius: 14, padding: files.length ? "24px" : "48px 24px",
            textAlign: "center", cursor: "pointer", transition: "all 0.18s",
            marginBottom: 16,
          }}
        >
          <input type="file" accept=".pdf" multiple ref={fileRef} style={{ display: "none" }} onChange={(e) => addFiles(e.target.files)} />
          {files.length === 0 ? (
            <>
              <div style={{ fontSize: 38, marginBottom: 10 }}>📂</div>
              <p style={{ margin: "0 0 5px", fontWeight: 700, color: "#334155", fontSize: 15 }}>Drop PDFs here or click to browse</p>
              <p style={{ margin: 0, color: "#94a3b8", fontSize: 13 }}>Up to 10 PDFs · Processed locally in your browser</p>
            </>
          ) : (
            <p style={{ margin: 0, color: "#64748b", fontSize: 13, fontWeight: 600 }}>
              + Add more PDFs {files.length < 10 ? `(${10 - files.length} slots remaining)` : "(limit reached)"}
            </p>
          )}
        </div>

        {/* ── Control bar ── */}
        {files.length > 0 && (
          <div style={{ background: "white", border: "1px solid #e2e8f0", borderRadius: 12, padding: "14px 20px", marginBottom: 20, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12, boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
            <div style={{ display: "flex", gap: 24 }}>
              <div>
                <span style={{ fontWeight: 800, fontSize: 20, color: "#0f172a" }}>{files.length}</span>
                <span style={{ color: "#94a3b8", fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.4, marginLeft: 6 }}>Files</span>
              </div>
              {done > 0 && (
                <>
                  <div style={{ width: 1, background: "#e2e8f0" }} />
                  <div>
                    <span style={{ fontWeight: 800, fontSize: 20, color: "#15803d" }}>{done}</span>
                    <span style={{ color: "#94a3b8", fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.4, marginLeft: 6 }}>Done</span>
                  </div>
                  <div style={{ width: 1, background: "#e2e8f0" }} />
                  <div>
                    <span style={{ fontWeight: 800, fontSize: 20, color: "#1d4ed8" }}>{totalFound}</span>
                    <span style={{ color: "#94a3b8", fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.4, marginLeft: 6 }}>References found</span>
                  </div>
                </>
              )}
              {errors > 0 && (
                <>
                  <div style={{ width: 1, background: "#e2e8f0" }} />
                  <div>
                    <span style={{ fontWeight: 800, fontSize: 20, color: "#dc2626" }}>{errors}</span>
                    <span style={{ color: "#94a3b8", fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.4, marginLeft: 6 }}>Errors</span>
                  </div>
                </>
              )}
            </div>

            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={() => setFiles([])} disabled={running}
                style={{ background: "none", border: "1px solid #e2e8f0", borderRadius: 8, padding: "9px 16px", cursor: running ? "not-allowed" : "pointer", fontSize: 13, fontWeight: 600, color: "#94a3b8" }}>
                Clear all
              </button>
              <button
                onClick={analyzeAll}
                disabled={!pending || running}
                style={{
                  background: (!pending || running) ? "#f1f5f9" : "linear-gradient(135deg, #1d4ed8, #3b82f6)",
                  color: (!pending || running) ? "#94a3b8" : "white",
                  border: "none", borderRadius: 8,
                  padding: "9px 22px", cursor: (!pending || running) ? "not-allowed" : "pointer",
                  fontSize: 14, fontWeight: 700,
                  boxShadow: (!pending || running) ? "none" : "0 3px 12px rgba(59,130,246,0.35)",
                  transition: "all 0.18s",
                }}
              >
                {running ? "⏳ Scanning…" : `Scan ${pending} file${pending !== 1 ? "s" : ""}`}
              </button>
            </div>
          </div>
        )}

        {/* ── File rows ── */}
        {files.map((item) => (
          <FileRow key={item.id} item={item} onRemove={() => removeFile(item.id)} />
        ))}

        {/* ── Empty state ── */}
        {files.length === 0 && (
          <div style={{ background: "white", border: "1px solid #e2e8f0", borderRadius: 14, padding: "32px 28px", textAlign: "center", color: "#94a3b8" }}>
            <div style={{ fontSize: 32, marginBottom: 10 }}>🗂️</div>
            <p style={{ margin: "0 0 4px", fontWeight: 600, color: "#475569", fontSize: 15 }}>No files added yet</p>
            <p style={{ margin: 0, fontSize: 13 }}>Upload up to 10 PDFs to start checking for supplementary content</p>
          </div>
        )}

        {/* ── Keyword panel ── */}
        {showKw && (
          <div style={{ background: "white", border: "1px solid #e2e8f0", borderRadius: 14, padding: 24, marginTop: 20, boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
            <h3 style={{ margin: "0 0 6px", color: "#0f172a", fontSize: 15, fontWeight: 700 }}>📚 Keyword Reference</h3>
            <p style={{ margin: "0 0 20px", color: "#64748b", fontSize: 13 }}>All terms scanned via regex in every analysis.</p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))", gap: 12 }}>
              {TERM_GROUPS.map((g, i) => (
                <div key={i} style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 10, padding: "12px 14px" }}>
                  <div style={{ fontWeight: 700, color: "#334155", fontSize: 13, marginBottom: 8 }}>{g.label}</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                    {g.covers.map((t, j) => (
                      <span key={j} style={{ background: "white", border: "1px solid #e2e8f0", borderRadius: 4, padding: "2px 7px", fontSize: 11, color: "#64748b", fontFamily: "monospace" }}>{t}</span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
