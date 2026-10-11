/**
 * Playbooks: step-by-step guides for common assistant tasks. The planner sees only their names and
 * when to use them; it opens one with {"tool": "open_playbook"} when a request matches and then
 * follows it with judgment (skipping or adapting steps when that makes more sense). Adding a workflow
 * means adding a playbook here, not changing the loop.
 */

export interface Playbook {
  name: string;
  title: string;
  /** When to open it (shown to the planner). */
  when: string;
  steps: string;
}

export const PLAYBOOKS: Playbook[] = [
  {
    name: "concepts",
    title: "Creating, linking and cleaning up concepts",
    when: "the user asks to suggest, create, link, unlink, rename or merge concepts, or to connect papers by topic (not for plain questions about a concept: use read_concept)",
    steps: `First decide which case this is.
A. The user names a concept ("add a concept X for this paper and link it to other relevant papers"):
   1. read_concept X — it may already exist (also under another name, plural or abbreviation; read_concept matches those).
   2. Find every saved paper it fits: find_saved_papers with a query, find_passages across the library (by meaning), related_in_library for the paper in question; read_paper or paper_info when unsure.
   3. Propose create_concept (or link_concept if it exists) with exactly those papers; add "related" to a broader concept when one exists. Stick to the concept the user named — mention other ideas in the reply instead of proposing them.
B. The user asks for suggestions ("suggest concepts for my library / this collection"):
   1. list_concepts to see what exists and how many papers each links; find_saved_papers (page with "offset" when there are many) so papers have keys; read papers whose abstracts are not enough.
   2. Think in layers. Concepts connect papers across the whole library — collections already group papers, so a concept that only restates a collection adds little.
      - General topics first, 1–3 words, the way a researcher tags a field: data or modality ("MRI", "CT", "point cloud"), method family ("diffusion models", "transformers"), task ("segmentation", "registration").
      - Specific ideas only when they connect several papers the general ones do not; give them "related" with their general concepts.
      - Not research topics: "method", "performance", "framework".
   3. Reuse before creating (link_concept), and extend existing concepts to every saved paper that fits, not only the ones discussed.
   4. Every concept gets "priority" (high: links many papers across collections; medium: useful; low: optional) and a one-line "why". Include your own ideas; anything you recommend must be proposed as an action.
C. Cleaning up — each is a different action; propose only what the user asked for:
   - Wrong paper: read_concept, then unlink_concept.
   - Duplicates ("merge these", "Point cloud" and "Point clouds"): read_concept each, then merge_concepts into the clearest name (it keeps the others as aliases and moves their papers, relations and note links).
   - Better name: rename_concept (the old name stays an alias). If the new name already exists, merge instead.
   - Broader / narrower: relate_concepts.`,
  },
  {
    name: "organize",
    title: "Organizing papers into collections and tags",
    when: "the user asks to save, group, sort or tag papers, or to make a collection",
    steps: `1. Find the papers so they have keys: search_library / find_saved_papers for saved papers (filters such as has_notes false or not_collection find what is not organized yet; page with "offset" so nothing is missed), search_papers for new ones (when literature search is on). To decide what saved papers are about, list them with "abstracts": true and group by what the abstracts say, not by title words; let the groups come from the papers rather than from an assumed theme.
2. list_workspace to see existing collections and tags; add to an existing collection when one fits instead of creating a near-duplicate.
3. Collections are for a project, question or reading list (a few to a few dozen papers); tags are short labels that cut across collections (e.g. "to-replicate", "survey", "dataset").
4. Name collections by their purpose ("Thesis ch. 2 — cardiac MRI segmentation"), with a one-line description.
5. Propose only what the user asked for; mention further ideas in the reply as suggestions they can ask for.`,
  },
  {
    name: "paper-reading",
    title: "Explaining and walking through a paper",
    when: "the user asks about one paper: a section, figure, table, passage, equation, its method, results or limitations, a walkthrough of the whole paper, what changed in a new version, or how it relates to their other papers",
    steps: `0. paper_info shows the user's own context for the paper (status, collections, concepts, notes); related_in_library shows how it connects to their other papers.
1. When <reader> shows what the user is looking at, "this section / figure / passage / page" means that: answer from the current page and the selection first, and read neighbouring pages (read_paper with "pages") when the context is cut off.
2. Choose how to look:
   - Text (method, argument, numbers stated in the text): read_paper with a focus or "pages"; find_passages to locate where something is discussed.
   - Figures, plots, tables, diagrams, equations as laid out: find the page (find_passages for "Figure 3" / "Table 2", or the caption), then view_page with the question. Text extraction scrambles tables and loses figures entirely — do not explain a figure from its caption alone.
   - Versions ("what changed in v3?"): compare_versions.
3. Check that the material was actually available: if read_paper says only the abstract is available, or view_page could not see the page, say so instead of guessing.
4. For a walkthrough or "explain each section": read the paper in consecutive page ranges in one round (read_paper with pages "1-4", "5-8", … up to the reference list), then explain section by section in the paper's order, citing pages like [P3] (p. 5).
5. Quote numbers exactly as written. Explain terms a reader outside the subfield may not know, in plain language, and connect each part to the paper's main question.
6. Do not propose workspace changes unless asked (add_highlight when the user asks to mark something).`,
  },
  {
    name: "notes-and-highlights",
    title: "Working with the user's notes and highlights",
    when: "the user asks about what they highlighted or wrote, to summarize, improve or rewrite their notes, to add something to a note, to highlight a passage, or to attach a note to papers",
    steps: `1. read_highlights for the paper(s); paper_info lists the notes on a paper (with keys) and read_note reads one (as numbered blocks); search_library / find_passages find notes and highlights by topic.
2. Keep three voices apart, in summaries and edits alike: what the paper's authors claim, what the user observed or wrote, and your own interpretation (label it as such).
3. To save something new: create_note, or append_to_note for an existing note the user means (ask which one in the reply if it is unclear). Cite papers as [P1] and pages like (p. 4).
4. To improve or rewrite an existing note: read_note, then edit_note with only the blocks that need to change. Keep the user's wording, comments and [[links]] unless they asked otherwise; never drop content silently — if something should go, say why in the reply. The user sees each block before and after and applies the edit.
5. To mark a passage in the PDF: find the exact words (read_paper or find_passages), then add_highlight with the quote and, if useful, a comment.
6. To attach an existing note to a paper, or link it to papers: find the note (search_library or paper_info), then link_note — "paper" for the one paper the note is about, "links" for others it relates to.`,
  },
  {
    name: "library-overview",
    title: "Reviewing the user's library and planning reading",
    when: "the user asks what is in a collection, tag or their library, what to read next, or to update reading statuses",
    steps: `1. Establish the goal before recommending: what the reading is for (a project, a thesis chapter, getting into a field), what the user already knows, and how much time they have. Use the conversation and their notes; if it is unclear, give a sensible default order and ask one short question in the reply.
2. find_saved_papers with the filters that match (collection, tag, concept, status "saved" for unread, has_notes false for papers not worked on yet). It reports the total: page with "offset" until you have all of them when the answer must be complete ("all", "every", "how many").
3. For "what should I read next": prefer saved papers that connect to what they are reading (related_in_library), foundational ones (many citations, cited by their other papers), and ones that serve the stated goal; give a short ordered list with one reason each.
4. For an overview: group the papers by theme (concepts help), name gaps (topics with few papers), and mention papers without PDFs.
5. Propose set_reading_status / remove_from_collection only when asked.`,
  },
  {
    name: "literature-review",
    title: "Reviewing the literature on a topic",
    when: "the user asks what is known about a topic, for related work, or for the state of the art (needs literature search)",
    steps: `1. Define the scope first: the question, the time span, the fields or modalities in and out. Decide whether a quick overview or a thorough review is wanted (a systematic review of many papers is the "systematic-screening" playbook).
2. Search broadly: 2–4 search_papers queries from different angles (synonyms, sub-problems, the data or modality involved); page with "offset" when the first results are all relevant.
3. Find the foundations: sort "citations" and follow the references of the key papers. Find the newest work: sort "newest", search_arxiv, and citations of the key papers with "sort": "newest".
4. Keep track of coverage: which angles were searched, and where results stopped being relevant. Look for contrary evidence on purpose (failures, negative results, critiques) rather than only confirming papers.
5. Read the papers the answer relies on (read_paper with a focus, find_passages, extract_fields for comparable facts) before concluding.
6. Organize the answer by theme or approach, distinguish established results (several independent papers) from single-paper claims, state what was not covered, and end with open problems and where to start reading.`,
  },
  {
    name: "compare-papers",
    title: "Comparing papers",
    when: "the user asks to compare papers, contrast approaches or choose a baseline",
    steps: `1. Establish the comparison axes first, from the user's purpose (e.g. for choosing a baseline: task, data, metric, compute, code availability).
2. extract_fields for all the papers at once with those axes (dataset, split, metric, main result, compute, assumptions…), so every value comes with its page or "not reported". read_paper / view_page (for result tables) where a value needs checking.
3. Judge comparability before concluding: different datasets, splits, metrics, pre-training or compute make numbers incomparable — say which comparisons are fair and which are not.
4. Present the table (in the reply), then what each paper is best used for and which to cite or use as a baseline for what. find_resources when code availability matters.`,
  },
  {
    name: "evidence-check",
    title: "Checking a claim, or papers that disagree",
    when: 'the user asks whether a paper really supports a claim, whether a claim is true, or what to make of papers that disagree ("which should I trust for my project?")',
    steps: `1. Establish the user's task and constraints (their data, setting, what decision depends on it).
2. Retrieve each paper's actual claim and the experiment behind it: find_passages in those papers with the claim in several phrasings, then read the surrounding pages (read_paper with "pages").
3. extract_fields for the conditions that matter: datasets, evaluation setting, baselines, metrics, variance or uncertainty, stated limitations. Inspect the result tables or figures with view_page.
4. Classify the support: the paper supports the claim directly, only under specific conditions, only indirectly (cites someone else), or not at all. Quote the exact sentence and page.
5. For disagreements: decide whether the disagreement survives the differences in conditions (different data, metrics, tuning effort, model sizes). Often it does not.
6. Give a conditional recommendation tied to the evidence ("for small datasets like yours, A's setting is closer…"), and say what evidence would settle it.`,
  },
  {
    name: "reproducibility",
    title: "Judging whether a result can be reproduced",
    when: "the user asks whether they can reproduce or run a paper's method, on their hardware or data, or which baseline fits their setup",
    steps: `1. Establish the user's constraints: hardware (GPU type, memory, count), time, data they have.
2. find_resources for the paper's code, data and models; read_resource the repository (README, requirements, configs) — code linked in the paper itself is the most likely official one.
3. extract_fields (or read_paper) for what the paper reports: training data and size, model size, batch size, training time and hardware, hyperparameters.
4. Work out what the user needs with calculate, stating every input and its source (e.g. parameters × bytes per parameter for weights; activations and optimizer state on top for training). Say clearly which numbers are estimates.
5. Name the gaps: missing code, missing hyperparameters, private data, compute far beyond the user's. Suggest the smallest faithful setup (a smaller variant, a released checkpoint, a subset).`,
  },
  {
    name: "research-question",
    title: "Exploring a research question or finding gaps",
    when: "the user wants to shape a research question, find gaps or open problems, or decide what to work on",
    steps: `1. Restate the question and its parts (data, method, task, setting); ask in the reply if something essential is missing.
2. Map what exists: the user's own library first (find_saved_papers, find_passages, read_concept), then the literature (search_papers per part and for the combination, search_arxiv for the newest work).
3. Look for gaps where they actually show: combinations nobody has tried, settings only evaluated on easy data, limitations papers state themselves (find_passages for "limitation", "future work"), and disagreements.
4. For each candidate gap, check it is real (a targeted search for the combination) before presenting it, and say how sure you are.
5. End with 2–4 concrete directions, each with the closest existing papers and the first experiment that would test it. Offer save_search to follow the area.`,
  },
  {
    name: "systematic-screening",
    title: "Screening many papers against criteria",
    when: "the user wants to screen or filter many papers (a collection, search results, dozens to hundreds) by inclusion and exclusion criteria, as for a systematic review",
    steps: `1. Write the criteria with the user's words, as explicit inclusion and exclusion rules (population or data, method, outcome, study type, years). Ask in the reply if a rule is ambiguous.
2. Gather the candidates: a collection, or papers found with search_papers (paged with "offset"; save them first if they should stay). Up to 500 papers per screening.
3. Propose start_screening with the title, criteria and the collection or papers ("use_full_text" only when abstracts are not enough; it is slower).
4. It runs in the background. Later, read_screening reports progress and the included and "maybe" papers with reasons; the user reviews and overrides decisions on the screening page, and can save the included papers as a collection.`,
  },
  {
    name: "stay-current",
    title: "Following topics and triaging new papers",
    when: "the user asks what is new, to follow a topic or keep up with a field, to go through their New papers, or which new papers matter for them",
    steps: `1. read_new_papers to see what the user follows and how many new papers each topic has; then read_new_papers with "search" for the topics in question (new papers come first, with abstracts).
2. Judge each new paper against the user's work, not in general: search_library / related_in_library / find_saved_papers (with "abstracts": true) show what they already have and care about. A new paper matters when it extends, challenges or directly competes with papers they saved, or fills a gap in a collection.
3. Answer with a short ranked list: what is worth reading now (and why, citing the related saved papers), what is merely related, and what can be skipped. Be honest when nothing stands out.
4. Propose only what the user asked for: save_papers (status "saved" or "reading") for the papers they want, add_to_collection where they fit.
5. Following topics: for "keep me up to date on X" propose save_search (source "arxiv" for the latest preprints, "biomedical" or "openreview" when the field calls for it; one focused query per topic, as a researcher would search). For setting up several from the library, derive one query per main collection or concept. Suggest stop_following for topics that keep bringing irrelevant papers — only propose it when the user agrees.`,
  },
  {
    name: "library-cleanup",
    title: "Cleaning up the library",
    when: "the user asks to tidy, clean up, deduplicate or reorganize their library, collections, tags or concepts",
    steps: `1. Look before proposing: list_workspace (collections, tags, concepts with counts), list_concepts, and find_saved_papers with in_collection false / has_concepts false (and "abstracts": true) for papers left out.
2. Find the problems, and report them in the reply even when you propose nothing:
   - Tags that mean the same ("survey" / "surveys" / "review"): rename_tag the clearest, then tag_papers + untag_papers to move papers onto it; delete_tag the empty leftovers only if the user wants them gone.
   - Concepts that duplicate each other: merge_concepts (never delete them); vague concepts: edit_concept or rename_concept.
   - Collections that overlap or are badly named: edit_collection (name, description); move papers with add_to_collection / remove_from_collection.
   - Papers in no collection, or without concepts: suggest where they belong.
   - Empty or one-paper collections and concepts: suggest merging them into a broader one.
3. Propose the safe fixes (renames, descriptions, moves, merges). Deleting (delete_collection, delete_tag, delete_concept, remove_from_library) only for what the user explicitly asked to delete; otherwise list candidates in the reply and let them decide.`,
  },
];

/** The list the planner sees: name, title and when to use each playbook. */
export function playbookIndex() {
  return PLAYBOOKS.map((p) => `- "${p.name}" — ${p.title}: when ${p.when}.`).join("\n");
}

export function findPlaybook(name: string) {
  const n = name.trim().toLowerCase();
  return PLAYBOOKS.find((p) => p.name === n) ?? null;
}
