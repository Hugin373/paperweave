"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/input";
import { api, errorMessage } from "@/lib/api";

export function splitAliases(text: string) {
  return [
    ...new Set(
      text
        .split(",")
        .map((a) => a.trim())
        .filter(Boolean),
    ),
  ];
}

export function NewConceptDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="New concept" description="A concept is an idea you want to track across papers and notes.">
        <NewConceptForm onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

/** Mounted only while the dialog is open, so every opening starts with an empty form. */
function NewConceptForm({ onDone }: { onDone: () => void }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [aliases, setAliases] = useState("");

  const create = useMutation({
    mutationFn: () =>
      api<{ id: string; name: string }>("/api/concepts", {
        body: {
          name: name.trim(),
          description,
          aliases: splitAliases(aliases),
        },
      }),
    onSuccess: async (c) => {
      await qc.invalidateQueries({ queryKey: ["concepts"] });
      onDone();
      toast.success(`Concept “${c.name}” created`);
      router.push(`/concepts/${c.id}`);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) create.mutate();
      }}
    >
      <Field label="Name" htmlFor="concept-name">
        <Input
          id="concept-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Metric depth"
          required
          maxLength={120}
          autoFocus
        />
      </Field>
      <Field label="Description" htmlFor="concept-description" hint="Optional — your own definition or understanding.">
        <Textarea
          id="concept-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
        />
      </Field>
      <Field
        label="Aliases"
        htmlFor="concept-aliases"
        hint="Optional, comma-separated (e.g. absolute depth, metric depth estimation)."
      >
        <Input id="concept-aliases" value={aliases} onChange={(e) => setAliases(e.target.value)} />
      </Field>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={create.isPending} disabled={!name.trim()}>
          Create concept
        </Button>
      </div>
    </form>
  );
}
