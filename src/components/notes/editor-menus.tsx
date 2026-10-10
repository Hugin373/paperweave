"use client";

import { DragHandle } from "@tiptap/extension-drag-handle-react";
import type { Node as PMNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { useEditorState, type Editor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import {
  Bold,
  ChevronDown,
  ChevronRight,
  Code,
  Copy,
  GripVertical,
  Highlighter,
  Italic,
  Link as LinkIcon,
  Plus,
  Strikethrough,
  Trash2,
  Underline,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
} from "@/components/ui/menu";
import { cn } from "@/lib/cn";
import { BLOCK_COMMANDS } from "./slash-command";
import { BLOCK_ICONS } from "./slash-menu";

/** Block types that "Turn into" can convert between. */
const TURN_INTO = BLOCK_COMMANDS.filter((c) =>
  ["text", "h1", "h2", "h3", "bullet", "numbered", "todo", "quote", "callout", "code"].includes(c.id),
);

function currentBlockLabel(editor: Editor) {
  if (editor.isActive("heading", { level: 1 })) return "Heading 1";
  if (editor.isActive("heading", { level: 2 })) return "Heading 2";
  if (editor.isActive("heading", { level: 3 })) return "Heading 3";
  if (editor.isActive("taskList")) return "To-do list";
  if (editor.isActive("bulletList")) return "Bulleted list";
  if (editor.isActive("orderedList")) return "Numbered list";
  if (editor.isActive("callout")) return "Callout";
  if (editor.isActive("blockquote")) return "Quote";
  if (editor.isActive("codeBlock")) return "Code";
  return "Text";
}

/** Converts the block containing the selection, first unwrapping lists/quotes/callouts. */
function turnInto(editor: Editor, id: string) {
  const chain = editor.chain().focus();
  if (editor.isActive("taskList")) chain.toggleTaskList();
  else if (editor.isActive("bulletList")) chain.toggleBulletList();
  else if (editor.isActive("orderedList")) chain.toggleOrderedList();
  if (editor.isActive("callout")) chain.toggleCallout();
  if (editor.isActive("blockquote")) chain.toggleBlockquote();
  chain.setParagraph().run();
  BLOCK_COMMANDS.find((c) => c.id === id)?.run(editor);
}

function MarkButton({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        "flex size-8 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-text",
        active && "text-accent-text",
      )}
    >
      <Icon className="size-4" aria-hidden />
    </button>
  );
}

/** Formatting toolbar that appears over selected text. */
export function FormatBubble({ editor }: { editor: Editor }) {
  const [linkMode, setLinkMode] = useState(false);
  const [href, setHref] = useState("");
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      block: currentBlockLabel(e),
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      underline: e.isActive("underline"),
      strike: e.isActive("strike"),
      code: e.isActive("code"),
      highlight: e.isActive("highlight"),
      link: e.isActive("link"),
      linkHref: (e.getAttributes("link").href as string | undefined) ?? "",
    }),
  });

  const applyLink = () => {
    const url = href.trim();
    const chain = editor.chain().focus().extendMarkRange("link");
    if (!url) chain.unsetLink().run();
    else chain.setLink({ href: /^[a-z]+:/i.test(url) ? url : `https://${url}` }).run();
    setLinkMode(false);
  };

  return (
    <BubbleMenu
      editor={editor}
      options={{ placement: "top", offset: 8 }}
      shouldShow={({ editor: e, state }) => {
        const { selection } = state;
        return (
          e.isEditable &&
          !selection.empty &&
          selection instanceof TextSelection &&
          !e.isActive("codeBlock") &&
          state.doc.textBetween(selection.from, selection.to).trim().length > 0
        );
      }}
      className="z-40 flex items-center gap-0.5 rounded-lg border border-border bg-surface p-1 shadow-lg"
    >
      {linkMode ? (
        <form
          className="flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            applyLink();
          }}
        >
          <input
            autoFocus
            value={href}
            onChange={(e) => setHref(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setLinkMode(false)}
            placeholder="Paste a link…"
            aria-label="Link URL"
            className="h-8 w-56 rounded-md bg-surface-2 px-2 text-[13px] outline-none"
          />
          <button
            type="submit"
            className="h-8 rounded-md px-2 text-[13px] font-medium text-accent-text hover:bg-surface-2"
          >
            {href.trim() ? "Apply" : "Remove"}
          </button>
        </form>
      ) : (
        <>
          <Menu>
            <MenuTrigger asChild>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                className="flex h-8 items-center gap-1 rounded-md px-2 text-[13px] font-medium text-text hover:bg-surface-2"
              >
                {s.block}
                <ChevronDown className="size-3.5 text-subtle" aria-hidden />
              </button>
            </MenuTrigger>
            <MenuContent align="start" onCloseAutoFocus={(e) => e.preventDefault()}>
              <MenuLabel>Turn into</MenuLabel>
              {TURN_INTO.map((c) => {
                const Icon = BLOCK_ICONS[c.icon];
                return (
                  <MenuItem key={c.id} onSelect={() => turnInto(editor, c.id)}>
                    <Icon />
                    {c.title}
                  </MenuItem>
                );
              })}
            </MenuContent>
          </Menu>
          <span className="mx-0.5 h-5 w-px bg-border" aria-hidden />
          <MarkButton
            icon={Bold}
            label="Bold (Ctrl+B)"
            active={s.bold}
            onClick={() => editor.chain().focus().toggleBold().run()}
          />
          <MarkButton
            icon={Italic}
            label="Italic (Ctrl+I)"
            active={s.italic}
            onClick={() => editor.chain().focus().toggleItalic().run()}
          />
          <MarkButton
            icon={Underline}
            label="Underline (Ctrl+U)"
            active={s.underline}
            onClick={() => editor.chain().focus().toggleUnderline().run()}
          />
          <MarkButton
            icon={Strikethrough}
            label="Strikethrough"
            active={s.strike}
            onClick={() => editor.chain().focus().toggleStrike().run()}
          />
          <MarkButton
            icon={Code}
            label="Inline code"
            active={s.code}
            onClick={() => editor.chain().focus().toggleCode().run()}
          />
          <MarkButton
            icon={Highlighter}
            label="Highlight"
            active={s.highlight}
            onClick={() => editor.chain().focus().toggleHighlight().run()}
          />
          <MarkButton
            icon={LinkIcon}
            label="Web link"
            active={s.link}
            onClick={() => {
              setHref(s.linkHref);
              setLinkMode(true);
            }}
          />
        </>
      )}
    </BubbleMenu>
  );
}

/**
 * Notion-style block handle shown to the left of the hovered block: "+" inserts a new block
 * below (and opens the "/" menu); the grip drags the block or opens its menu.
 */
export function BlockHandle({ editor }: { editor: Editor }) {
  const [target, setTarget] = useState<{ node: PMNode; pos: number } | null>(null);

  const selectBlock = () => {
    if (!target) return;
    editor.chain().setNodeSelection(target.pos).run();
  };

  const addBelow = () => {
    if (!target) return;
    const end = target.pos + target.node.nodeSize;
    editor
      .chain()
      .insertContentAt(end, { type: "paragraph", content: [{ type: "text", text: "/" }] })
      .setTextSelection(end + 2)
      .focus()
      .run();
  };

  const duplicate = () => {
    if (!target) return;
    editor
      .chain()
      .insertContentAt(target.pos + target.node.nodeSize, target.node.toJSON())
      .focus()
      .run();
  };

  const remove = () => {
    if (!target) return;
    editor
      .chain()
      .deleteRange({ from: target.pos, to: target.pos + target.node.nodeSize })
      .focus()
      .run();
  };

  const convert = (id: string) => {
    if (!target) return;
    // Put the cursor inside the block, then convert it.
    editor
      .chain()
      .setTextSelection(target.pos + 1)
      .run();
    turnInto(editor, id);
  };

  return (
    <DragHandle
      editor={editor}
      onNodeChange={({ node, pos }) => setTarget(node ? { node, pos } : null)}
      className="flex items-center gap-0.5 pr-1"
    >
      <button
        type="button"
        onClick={addBelow}
        aria-label="Add a block below"
        title="Click to add a block below"
        className="flex size-6 items-center justify-center rounded text-subtle hover:bg-surface-2 hover:text-text"
      >
        <Plus className="size-4" aria-hidden />
      </button>
      <Menu
        onOpenChange={(open) => {
          if (open) {
            editor.commands.setMeta("lockDragHandle", true);
            selectBlock();
          } else editor.commands.setMeta("lockDragHandle", false);
        }}
      >
        <MenuTrigger asChild>
          <button
            type="button"
            aria-label="Drag to move, click for block options"
            title="Drag to move · click for options"
            className="flex h-6 w-5 cursor-grab items-center justify-center rounded text-subtle hover:bg-surface-2 hover:text-text active:cursor-grabbing"
          >
            <GripVertical className="size-4" aria-hidden />
          </button>
        </MenuTrigger>
        <MenuContent align="start" side="left" onCloseAutoFocus={(e) => e.preventDefault()}>
          <MenuSub>
            <MenuSubTrigger>
              Turn into
              <ChevronRight className="ml-auto" />
            </MenuSubTrigger>
            <MenuSubContent>
              {TURN_INTO.map((c) => {
                const Icon = BLOCK_ICONS[c.icon];
                return (
                  <MenuItem key={c.id} onSelect={() => convert(c.id)}>
                    <Icon />
                    {c.title}
                  </MenuItem>
                );
              })}
            </MenuSubContent>
          </MenuSub>
          <MenuItem onSelect={duplicate}>
            <Copy />
            Duplicate
          </MenuItem>
          <MenuSeparator />
          <MenuItem danger onSelect={remove}>
            <Trash2 />
            Delete
          </MenuItem>
        </MenuContent>
      </Menu>
    </DragHandle>
  );
}
