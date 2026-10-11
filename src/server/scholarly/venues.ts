/**
 * Short names people type for venues, and the full names the scholarly sources file papers under. Semantic
 * Scholar knows many short names itself ("ECCV", "MICCAI") but not all ("TPAMI"); OpenAlex knows few. Both
 * are asked with the typed name and its full names.
 */
const ALIASES: Record<string, string[]> = {
  // Computer vision, medical imaging
  cvpr: ["Computer Vision and Pattern Recognition"],
  iccv: ["IEEE International Conference on Computer Vision"],
  eccv: ["European Conference on Computer Vision"],
  wacv: ["IEEE Workshop/Winter Conference on Applications of Computer Vision"],
  bmvc: ["British Machine Vision Conference"],
  miccai: ["International Conference on Medical Image Computing and Computer-Assisted Intervention"],
  isbi: ["IEEE International Symposium on Biomedical Imaging"],
  ipmi: ["Information Processing in Medical Imaging"],
  midl: ["International Conference on Medical Imaging with Deep Learning"],
  media: ["Medical Image Analysis"],
  tmi: ["IEEE Transactions on Medical Imaging"],
  tpami: ["IEEE Transactions on Pattern Analysis and Machine Intelligence"],
  pami: ["IEEE Transactions on Pattern Analysis and Machine Intelligence"],
  ijcv: ["International Journal of Computer Vision"],
  tip: ["IEEE Transactions on Image Processing"],
  // Machine learning, AI, data mining
  neurips: ["Neural Information Processing Systems"],
  nips: ["Neural Information Processing Systems"],
  icml: ["International Conference on Machine Learning"],
  iclr: ["International Conference on Learning Representations"],
  aaai: ["AAAI Conference on Artificial Intelligence"],
  ijcai: ["International Joint Conference on Artificial Intelligence"],
  aistats: ["International Conference on Artificial Intelligence and Statistics"],
  uai: ["Conference on Uncertainty in Artificial Intelligence"],
  jmlr: ["Journal of Machine Learning Research"],
  tmlr: ["Transactions on Machine Learning Research"],
  kdd: ["Knowledge Discovery and Data Mining"],
  // Language
  acl: ["Annual Meeting of the Association for Computational Linguistics"],
  emnlp: ["Conference on Empirical Methods in Natural Language Processing"],
  naacl: ["North American Chapter of the Association for Computational Linguistics"],
  eacl: ["Conference of the European Chapter of the Association for Computational Linguistics"],
  coling: ["International Conference on Computational Linguistics"],
  tacl: ["Transactions of the Association for Computational Linguistics"],
  // Robotics, graphics, interaction, retrieval, web
  icra: ["IEEE International Conference on Robotics and Automation"],
  iros: ["IEEE/RSJ International Conference on Intelligent Robots and Systems"],
  corl: ["Conference on Robot Learning"],
  rss: ["Robotics: Science and Systems"],
  siggraph: ["International Conference on Computer Graphics and Interactive Techniques"],
  chi: ["International Conference on Human Factors in Computing Systems"],
  sigir: ["Annual International ACM SIGIR Conference on Research and Development in Information Retrieval"],
  www: ["The Web Conference"],
  // Science and medicine
  pnas: ["Proceedings of the National Academy of Sciences of the United States of America"],
  nejm: ["New England Journal of Medicine"],
  bmj: ["British Medical Journal"],
  "nat commun": ["Nature Communications"],
  "sci rep": ["Scientific Reports"],
};

const key = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** The typed venue followed by the full names it stands for ("TPAMI" → its journal's full name). */
export function venueNames(venue: string): string[] {
  const typed = venue.trim();
  return [...new Set([typed, ...(ALIASES[key(typed)] ?? [])])].filter(Boolean);
}
