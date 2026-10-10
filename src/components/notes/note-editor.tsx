"use client";

import { Details, DetailsContent, DetailsSummary } from "@tiptap/extension-details";
import Highlight from "@tiptap/extension-highlight";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import Placeholder from "@tiptap/extension-placeholder";
import { TableKit } from "@tiptap/extension-table";
import Typography from "@tiptap/extension-typography";
import { EditorContent, useEditor, type Editor, type JSONContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useMemo } from "react";
import { cn } from "@/lib/cn";
import { Callout } from "./callout";
import { BlockHandle, FormatBubble } from "./editor-menus";
import { createKnowledgeMention } from "./mention-extension";
import { SlashCommand } from "./slash-command";

/** Starts a link: inserts "[[" at the cursor, which opens the link search popup. */
export function startLink(editor: Editor) {
  const { $from } = editor.state.selection;
  const before = $from.nodeBefore?.isText ? ($from.nodeBefore.text ?? "") : "";
  const needsSpace = before.length > 0 && !/\s$/.test(before);
  editor
    .chain()
    .focus()
    .insertContent(needsSpace ? " [[" : "[[")
    .run();
}

function placeholderFor(node: { type: { name: string }; attrs: Record<string, unknown> }) {
  switch (node.type.name) {
    case "heading":
      return `Heading ${node.attrs.level as number}`;
    case "detailsSummary":
      return "Toggle";
    case "codeBlock":
      return "";
    default:
      return "Type '/' for commands, '[[' to link a paper, concept or note";
  }
}

/**
 * Block-based note editor in the spirit of Notion: no fixed toolbar — "/" inserts blocks,
 * selecting text shows formatting, and the handle left of each block adds, moves or converts
 * it. Markdown shortcuts work too (#, -, 1., [], >, ```, ---).
 */
export function NoteEditor({
  noteId,
  content,
  editable,
  onChange,
  onReady,
  onOpenLink,
  onConceptCreated,
  compact,
}: {
  noteId: string;
  content: JSONContent;
  editable: boolean;
  onChange: (doc: JSONContent) => void;
  onReady?: (editor: Editor) => void;
  /** Called when a knowledge link is clicked. */
  onOpenLink: (href: string, newTab: boolean) => void;
  onConceptCreated?: () => void;
  /** Smaller type and spacing, for side panels. */
  compact?: boolean;
}) {
  const mention = useMemo(() => createKnowledgeMention({ noteId, onConceptCreated }), [noteId, onConceptCreated]);
  const editor = useEditor(
    {
      immediatelyRender: false,
      editable,
      extensions: [
        StarterKit.configure({ link: { openOnClick: false, autolink: true } }),
        Placeholder.configure({
          placeholder: ({ node }) => placeholderFor(node),
          includeChildren: true,
        }),
        TaskList,
        TaskItem.configure({ nested: true }),
        Details.configure({ persist: true, HTMLAttributes: { class: "toggle" } }),
        DetailsSummary,
        DetailsContent,
        TableKit.configure({ table: { resizable: false } }),
        Highlight,
        Typography,
        Callout,
        SlashCommand,
        mention,
      ],
      content,
      editorProps: {
        attributes: { "aria-label": "Note content", class: compact ? "py-2" : "py-3" },
        handleClick: (_view, _pos, event) => {
          const el = (event.target as HTMLElement).closest("a.mention") as HTMLAnchorElement | null;
          if (!el) return false;
          event.preventDefault();
          onOpenLink(el.getAttribute("href") ?? "#", event.metaKey || event.ctrlKey);
          return true;
        },
      },
      onUpdate: ({ editor: e }) => onChange(e.getJSON()),
    },
    [mention],
  );

  useEffect(() => {
    if (editor) editor.setEditable(editable);
  }, [editor, editable]);

  useEffect(() => {
    if (editor && onReady) onReady(editor);
  }, [editor, onReady]);

  return (
    <div className={cn("note-editor relative", compact ? "compact pl-12" : "pl-14")}>
      {editor && editable && (
        <>
          <BlockHandle editor={editor} />
          <FormatBubble editor={editor} />
        </>
      )}
      <EditorContent editor={editor} />
    </div>
  );
}
