import { Extension, type Editor, type Range } from "@tiptap/core";
import { ReactRenderer } from "@tiptap/react";
import Suggestion, { type SuggestionOptions, type SuggestionProps } from "@tiptap/suggestion";
import { PluginKey } from "@tiptap/pm/state";
import { SlashMenu, type SlashMenuHandle } from "./slash-menu";

export type BlockIcon =
  | "text"
  | "h1"
  | "h2"
  | "h3"
  | "bullet"
  | "numbered"
  | "todo"
  | "quote"
  | "callout"
  | "toggle"
  | "code"
  | "divider"
  | "table"
  | "link";

export interface BlockCommand {
  id: string;
  title: string;
  description: string;
  icon: BlockIcon;
  group: "Basic blocks" | "Knowledge";
  keywords: string[];
  /** Runs after the "/query" text has been removed. */
  run: (editor: Editor) => void;
}

/** Block types offered by the "/" menu, the "+" button and "Turn into". */
export const BLOCK_COMMANDS: BlockCommand[] = [
  {
    id: "text",
    title: "Text",
    description: "Plain paragraph",
    icon: "text",
    group: "Basic blocks",
    keywords: ["paragraph", "p", "plain"],
    run: (e) => e.chain().focus().setParagraph().run(),
  },
  {
    id: "h1",
    title: "Heading 1",
    description: "Big section heading",
    icon: "h1",
    group: "Basic blocks",
    keywords: ["title", "h1", "#"],
    run: (e) => e.chain().focus().setHeading({ level: 1 }).run(),
  },
  {
    id: "h2",
    title: "Heading 2",
    description: "Medium section heading",
    icon: "h2",
    group: "Basic blocks",
    keywords: ["subtitle", "h2", "##"],
    run: (e) => e.chain().focus().setHeading({ level: 2 }).run(),
  },
  {
    id: "h3",
    title: "Heading 3",
    description: "Small section heading",
    icon: "h3",
    group: "Basic blocks",
    keywords: ["h3", "###"],
    run: (e) => e.chain().focus().setHeading({ level: 3 }).run(),
  },
  {
    id: "bullet",
    title: "Bulleted list",
    description: "Simple bulleted list",
    icon: "bullet",
    group: "Basic blocks",
    keywords: ["ul", "unordered", "-"],
    run: (e) => e.chain().focus().toggleBulletList().run(),
  },
  {
    id: "numbered",
    title: "Numbered list",
    description: "List with numbering",
    icon: "numbered",
    group: "Basic blocks",
    keywords: ["ol", "ordered", "1."],
    run: (e) => e.chain().focus().toggleOrderedList().run(),
  },
  {
    id: "todo",
    title: "To-do list",
    description: "Track tasks with checkboxes",
    icon: "todo",
    group: "Basic blocks",
    keywords: ["task", "checkbox", "check", "[]"],
    run: (e) => e.chain().focus().toggleTaskList().run(),
  },
  {
    id: "toggle",
    title: "Toggle",
    description: "Collapsible section",
    icon: "toggle",
    group: "Basic blocks",
    keywords: ["details", "collapse", "fold", ">"],
    run: (e) => e.chain().focus().setDetails().run(),
  },
  {
    id: "quote",
    title: "Quote",
    description: "Capture a quotation",
    icon: "quote",
    group: "Basic blocks",
    keywords: ["blockquote", "citation", '"'],
    run: (e) => e.chain().focus().toggleBlockquote().run(),
  },
  {
    id: "callout",
    title: "Callout",
    description: "Make something stand out",
    icon: "callout",
    group: "Basic blocks",
    keywords: ["note", "info", "tip", "warning", "highlight box"],
    run: (e) => e.chain().focus().toggleCallout().run(),
  },
  {
    id: "code",
    title: "Code",
    description: "Code or equation snippet",
    icon: "code",
    group: "Basic blocks",
    keywords: ["codeblock", "snippet", "```"],
    run: (e) => e.chain().focus().toggleCodeBlock().run(),
  },
  {
    id: "table",
    title: "Table",
    description: "Compare results in a grid",
    icon: "table",
    group: "Basic blocks",
    keywords: ["grid", "compare", "matrix"],
    run: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
  {
    id: "divider",
    title: "Divider",
    description: "Separate sections",
    icon: "divider",
    group: "Basic blocks",
    keywords: ["hr", "line", "separator", "---"],
    run: (e) => e.chain().focus().setHorizontalRule().run(),
  },
  {
    id: "link",
    title: "Link to paper, concept or note",
    description: "Connect this note to your knowledge",
    icon: "link",
    group: "Knowledge",
    keywords: ["mention", "paper", "concept", "note", "[["],
    run: (e) => e.chain().focus().insertContent("[[").run(),
  },
];

export function filterCommands(query: string): BlockCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return BLOCK_COMMANDS;
  return BLOCK_COMMANDS.filter(
    (c) => c.title.toLowerCase().includes(q) || c.keywords.some((k) => k.toLowerCase().startsWith(q)),
  );
}

type MenuProps = { items: BlockCommand[]; command: (c: BlockCommand) => void };

/** "/" opens a block menu, like Notion. */
export const SlashCommand = Extension.create({
  name: "slashCommand",
  addProseMirrorPlugins() {
    const options: SuggestionOptions<BlockCommand> = {
      editor: this.editor,
      char: "/",
      pluginKey: new PluginKey("slashCommand"),
      // Not inside code, and only at the start of a word.
      allow: ({ editor }) => !editor.isActive("codeBlock"),
      items: ({ query }) => filterCommands(query),
      command: ({ editor, range, props }: { editor: Editor; range: Range; props: BlockCommand }) => {
        editor.chain().focus().deleteRange(range).run();
        props.run(editor);
      },
      render: () => {
        let component: ReactRenderer<SlashMenuHandle, MenuProps> | null = null;
        let unmount: (() => void) | undefined;
        const toProps = (p: SuggestionProps<BlockCommand>): MenuProps => ({
          items: p.items,
          command: (c) => p.command(c),
        });
        return {
          onStart: (props) => {
            component = new ReactRenderer(SlashMenu, { props: toProps(props), editor: props.editor });
            unmount = props.mount(component.element as HTMLElement);
          },
          onUpdate: (props) => component?.updateProps(toProps(props)),
          onKeyDown: ({ event }) => {
            if (event.key === "Escape") return false;
            return component?.ref?.onKeyDown(event) ?? false;
          },
          onExit: () => {
            unmount?.();
            component?.destroy();
            component = null;
          },
        };
      },
    };
    return [Suggestion(options)];
  },
});
