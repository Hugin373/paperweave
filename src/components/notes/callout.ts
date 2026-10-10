import { mergeAttributes, Node, wrappingInputRule } from "@tiptap/core";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    callout: {
      /** Wraps the selection in a callout box, or unwraps it. */
      toggleCallout: () => ReturnType;
    };
  }
}

/** A highlighted box for key takeaways (Notion-style callout). Type "!> " to start one. */
export const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,

  parseHTML() {
    return [{ tag: "div[data-callout]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-callout": "" }), 0];
  },

  addCommands() {
    return {
      toggleCallout:
        () =>
        ({ commands }) =>
          commands.toggleWrap(this.name),
    };
  },

  addInputRules() {
    return [wrappingInputRule({ find: /^!>\s$/, type: this.type })];
  },
});
