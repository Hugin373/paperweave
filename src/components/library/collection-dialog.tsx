"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/input";
import { api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { COLLECTION_COLORS, collectionColor } from "@/lib/collection-colors";

type CollectionInput = { id: string; name: string; description: string; color: string | null };

/** Create (no `collection`) or edit a collection. */
export function CollectionDialog({
  open,
  onOpenChange,
  collection,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  collection?: CollectionInput;
  onCreated?: (id: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={collection ? "Edit collection" : "New collection"}
        description="Collections are lightweight groups. A paper can be in several."
      >
        {/* Mounted fresh each time the dialog opens, so the form starts from the current values. */}
        <CollectionForm collection={collection} onDone={() => onOpenChange(false)} onCreated={onCreated} />
      </DialogContent>
    </Dialog>
  );
}

function CollectionForm({
  collection,
  onDone,
  onCreated,
}: {
  collection?: CollectionInput;
  onDone: () => void;
  onCreated?: (id: string) => void;
}) {
  const qc = useQueryClient();
  const router = useRouter();
  const [name, setName] = useState(collection?.name ?? "");
  const [description, setDescription] = useState(collection?.description ?? "");
  // New collections leave the color unset and get the least-used one from the server.
  const [color, setColor] = useState<string | null>(collection?.color ? collectionColor(collection) : null);

  const save = useMutation({
    mutationFn: () =>
      collection
        ? api<{ id: string }>(`/api/collections/${collection.id}`, {
            method: "PATCH",
            body: { name, description, color },
          })
        : api<{ id: string }>("/api/collections", { body: { name, description, color } }),
    onSuccess: async (row) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["collections"] }),
        qc.invalidateQueries({ queryKey: ["collection"] }),
      ]);
      onDone();
      if (!collection) {
        toast.success("Collection created");
        if (onCreated) onCreated(row.id);
        else router.push(`/library?collection=${row.id}`);
      }
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) save.mutate();
      }}
    >
      <Field label="Name" htmlFor="collection-name">
        <Input
          id="collection-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Spatial AI"
          autoFocus
          required
          maxLength={100}
        />
      </Field>
      <Field label="Description" htmlFor="collection-description" hint="Optional">
        <Textarea
          id="collection-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          maxLength={2000}
        />
      </Field>
      <div className="space-y-1.5">
        <span className="text-[13px] font-medium">
          Color{color === null && <span className="font-normal text-muted"> · picked automatically</span>}
        </span>
        <div className="flex gap-2" role="radiogroup" aria-label="Color">
          {COLLECTION_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={color === c}
              aria-label={c}
              onClick={() => setColor(c)}
              className={cn("size-6 rounded-full border-2", color === c ? "border-text" : "border-transparent")}
              style={{ background: c }}
            />
          ))}
        </div>
      </div>
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={save.isPending} disabled={!name.trim()}>
          {collection ? "Save" : "Create"}
        </Button>
      </div>
    </form>
  );
}
