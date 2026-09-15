import { type Extensions } from "@tiptap/core";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { Table } from "@tiptap/extension-table";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableRow } from "@tiptap/extension-table-row";
import { TaskItem } from "@tiptap/extension-task-item";
import { TaskList } from "@tiptap/extension-task-list";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import {
  ProtectedMarkdownBlock,
  type ProtectedBlockRenderer,
} from "./protected-node";

export function createAgencyMarkdownExtensions(args?: {
  renderProtected?: ProtectedBlockRenderer;
}): Extensions {
  return [
    ProtectedMarkdownBlock.configure({
      renderProtected: args?.renderProtected,
    }),
    StarterKit.configure({ link: false }),
    Link.configure({ openOnClick: false, autolink: true }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Table.configure({ resizable: false, lastColumnResizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    Placeholder.configure({ placeholder: "Текст документа" }),
    Markdown,
  ];
}
