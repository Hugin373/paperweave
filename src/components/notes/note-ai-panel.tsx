"use client";

import type { Editor } from "@tiptap/react";
import { CornerDownLeft, Sparkles } from "lucide-react";
import { useRef, useState } from "react";
import { AiNotConfigured, AiOutput } from "@/components/ai/ai";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorMessage, streamText } from "@/lib/api";
import { useAiEnabled } from "@/lib/hooks";
import { SidePanel } from "./note-sidebar";
import { ModelPicker } from "@/components/ai/model-picker";

type Action = "summarize" | "rewrite" | "explain" | "organize" | "suggest_links" | "ask";

const ACTIONS: { key: Exclude<Action, "ask">; label: string; usesSelection?: boolean }[] = [
  { key: "summarize", label: "Summarize" },
  { key: "rewrite", label: "Rewrite selection", usesSelection: true },
  { key: "explain", label: "Explain", usesSelection: true },
  { key: "organize", label: "Organize" },
  { key: "suggest_links", label: "Suggest links" },
];

function selectedText(editor: Editor) {
  const { from, to, empty } = editor.state.selection;
  return empty ? "" : editor.state.doc.textBetween(from, to, "\n\n", " ");
}

/** Appends plain text below the note as new paragraphs (never replaces the user's text). */
function insertBelow(editor: Editor, text: string) {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => ({ type: "paragraph", content: [{ type: "text", text: p.replace(/\n/g, " ") }] }));
  if (!paragraphs.length) return;
  editor.chain().focus("end").insertContentAt(editor.state.doc.content.size, paragraphs).run();
}

export function NoteAiPanel({ editor }: { editor: Editor | null }) {
  const enabled = useAiEnabled();
  const [output, setOutput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const abort = useRef<AbortController | null>(null);

  if (!enabled) {
    return (
      <SidePanel title="AI assist">
        <AiNotConfigured compact />
      </SidePanel>
    );
  }

  const run = async (action: Action, usesSelection?: boolean) => {
    if (!editor) return;
    const selection = selectedText(editor);
    const text = (usesSelection && selection) || editor.getText({ blockSeparator: "\n\n" });
    if (!text.trim()) {
      setError("Write something first — AI works on your note's text.");
      return;
    }
    abort.current?.abort();
    abort.current = new AbortController();
    setOutput("");
    setError(null);
    setLoading(true);
    try {
      await streamText(
        "/api/ai/notes",
        { action, text, question: action === "ask" ? question : undefined },
        setOutput,
        abort.current.signal,
      );
    } catch (err) {
      if ((err as Error).name !== "AbortError") setError(errorMessage(err, "The AI request failed."));
    } finally {
      setLoading(false);
    }
  };

  return (
    <SidePanel title="AI assist">
      <div className="-mt-1 mb-2">
        <ModelPicker />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {ACTIONS.map((a) => (
          <Button
            key={a.key}
            size="sm"
            variant="ai"
            disabled={loading || !editor}
            onClick={() => run(a.key, a.usesSelection)}
          >
            {a.label}
          </Button>
        ))}
      </div>
      <form
        className="mt-2 flex gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (question.trim()) run("ask");
        }}
      >
        <Input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask about this note…"
          aria-label="Ask AI about this note"
          className="h-8"
        />
        <Button size="icon" variant="ai" type="submit" disabled={loading || !question.trim()} aria-label="Ask">
          <Sparkles />
        </Button>
      </form>
      <AiOutput
        className="mt-3"
        text={output}
        loading={loading}
        error={error}
        actions={
          output && !loading && editor ? (
            <Button size="sm" variant="ghost" onClick={() => insertBelow(editor, output)}>
              <CornerDownLeft />
              Insert below
            </Button>
          ) : null
        }
      />
      <p className="mt-2 text-[12px] text-subtle">
        Only this note’s text (and for link suggestions, your concept and paper names) is sent to the AI provider.
      </p>
    </SidePanel>
  );
}
