import Mention from "@tiptap/extension-mention";
import { ReactRenderer, type Editor } from "@tiptap/react";
import type { SuggestionOptions, SuggestionProps } from "@tiptap/suggestion";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api";
import { parseMentionId } from "@/lib/prosemirror";
import { fetchLinkTargets, hrefFor } from "./link-targets";
import { MentionList, type MentionItem, type MentionListHandle } from "./mention-list";

/** Inserts a knowledge-link mention, replacing `range` (the typed trigger + query). */
export function insertMention(
  editor: Editor,
  range: { from: number; to: number },
  target: { type: string; id: string; label: string },
) {
  editor
    .chain()
    .focus()
    .insertContentAt(range, [
      { type: "mention", attrs: { id: `${target.type}:${target.id}`, label: target.label } },
      { type: "text", text: " " },
    ])
    .run();
}

function suggestion(
  char: string,
  opts: { noteId?: string; onConceptCreated?: () => void },
): Omit<SuggestionOptions<MentionItem>, "editor"> {
  return {
    char,
    allowSpaces: char === "[[",
    debounce: 150,
    items: async ({ query }) => {
      const q = query.replace(/\]+$/, "").trim();
      let results: MentionItem[] = [];
      try {
        results = await fetchLinkTargets(q, { exclude: opts.noteId });
      } catch {
        results = [];
      }
      const exists = results.some((r) => r.type === "concept" && r.label.toLowerCase() === q.toLowerCase());
      if (q && !exists) results.push({ type: "create", label: q });
      return results;
    },
    command: ({ editor, range, props: item }) => {
      if (item.type !== "create") {
        insertMention(editor, range, item);
        return;
      }
      api<{ id: string; name: string }>("/api/concepts", { body: { name: item.label } })
        .then((c) => {
          insertMention(editor, range, { type: "concept", id: c.id, label: c.name });
          toast.success(`Concept “${c.name}” created`);
          opts.onConceptCreated?.();
        })
        .catch((err) => toast.error(errorMessage(err, "Could not create the concept.")));
    },
    render: () => {
      let component: ReactRenderer<
        MentionListHandle,
        { items: MentionItem[]; query: string; loading?: boolean; command: (i: MentionItem) => void }
      > | null = null;
      let unmount: (() => void) | undefined;
      const toProps = (p: SuggestionProps<MentionItem>) => ({
        items: p.items,
        query: p.query,
        loading: (p as SuggestionProps<MentionItem> & { loading?: boolean }).loading,
        command: (i: MentionItem) => p.command(i),
      });
      return {
        onStart: (props) => {
          component = new ReactRenderer(MentionList, { props: toProps(props), editor: props.editor });
          unmount = props.mount(component.element as HTMLElement);
        },
        onUpdate: (props) => component?.updateProps(toProps(props)),
        onKeyDown: ({ event }) => component?.ref?.onKeyDown(event) ?? false,
        onExit: () => {
          unmount?.();
          component?.destroy();
          component = null;
        },
      };
    },
  };
}

/**
 * Mention node used for knowledge links. `id` is "<type>:<uuid>"; it renders as a link so
 * notes stay navigable, and parses back from that HTML on copy/paste.
 */
export function createKnowledgeMention(opts: { noteId?: string; onConceptCreated?: () => void }) {
  return Mention.extend({
    parseHTML() {
      return [{ tag: "a.mention[data-id]" }, { tag: 'span[data-type="mention"]' }];
    },
  }).configure({
    deleteTriggerWithBackspace: true,
    renderText: ({ node }) => `[[${node.attrs.label ?? ""}]]`,
    renderHTML: ({ node }) => {
      const parsed = parseMentionId(node.attrs.id);
      return [
        "a",
        {
          class: "mention",
          "data-type": parsed?.type ?? "note",
          "data-id": node.attrs.id,
          "data-label": node.attrs.label,
          href: parsed ? hrefFor(parsed.type, parsed.id) : "#",
          title: "Click to open",
        },
        node.attrs.label ?? "",
      ];
    },
    suggestions: [suggestion("[[", opts), suggestion("@", opts)],
  });
}
