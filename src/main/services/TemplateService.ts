/**
 * TemplateService.ts — Organization templates (built-in + custom).
 *
 * Built-in templates are hardcoded. Custom templates are persisted to
 * custom_templates.json. Popularity counts are in template_usage.json.
 * Both are stored in userData.
 */

import fs from "fs";
import path from "path";
import { app } from "electron";

const fsp = fs.promises;

// ── Types ──────────────────────────────────────────────────────

export type TemplateCategory = "general" | "professional" | "creative" | "development";

export interface OrganizationTemplate {
  id: string;
  name: string;
  description: string;
  icon: string;
  prompt: string;
  category: TemplateCategory;
  tags: string[];
  popularity: number;
  isCustom: boolean;
}

// ── Built-in Templates ─────────────────────────────────────────

const BUILTIN_TEMPLATES: OrganizationTemplate[] = [
  // ── General ──────────────────────────────────────────
  {
    id: "bt_by_type",
    name: "By File Type",
    description: "Sort into Documents, Images, Videos, Audio, Spreadsheets, and more",
    icon: "📁",
    prompt: "Organize into folders by file type: Documents (doc, docx, pdf, txt), Images (jpg, png, gif, svg, webp), Videos (mp4, mov, avi, mkv), Audio (mp3, wav, flac, aac), Spreadsheets (xlsx, csv, xls), Presentations (pptx, ppt), Archives (zip, rar, 7z, tar), and Other for everything else.",
    category: "general",
    tags: ["file type", "extension", "sort"],
    popularity: 0,
    isCustom: false,
  },
  {
    id: "bt_by_date",
    name: "By Date",
    description: "Organize by year and month of last modification",
    icon: "📅",
    prompt: "Organize by the year and month each file was last modified. Structure: Year folder → Month folder (e.g. 2025/September). Put files from the current month in a 'Recent' folder instead.",
    category: "general",
    tags: ["date", "year", "month", "timeline"],
    popularity: 0,
    isCustom: false,
  },
  {
    id: "bt_clean_downloads",
    name: "Clean Downloads",
    description: "Sort a messy Downloads folder into logical groups",
    icon: "🧹",
    prompt: "Sort this downloads folder: move documents to Documents, images to Images, installers/DMGs/EXEs to Installers, archives (zip/rar) to Archives, and anything older than 90 days to Old Downloads. Leave recent files from the last week in place.",
    category: "general",
    tags: ["downloads", "clean", "archive"],
    popularity: 0,
    isCustom: false,
  },
  {
    id: "bt_docs_vs_media",
    name: "Docs vs Media",
    description: "Separate text-based documents from visual/audio media",
    icon: "📄",
    prompt: "Create two main folders: Documents (for all text-based files — pdf, doc, docx, txt, md, xlsx, csv, pptx) and Media (for all visual/audio files — jpg, png, gif, mp4, mov, mp3, wav, psd, ai, svg). Put anything that doesn't fit into Miscellaneous.",
    category: "general",
    tags: ["documents", "media", "separate"],
    popularity: 0,
    isCustom: false,
  },
  {
    id: "bt_work_vs_personal",
    name: "Work vs Personal",
    description: "Sort files by context using filename keywords",
    icon: "🗂️",
    prompt: "Sort files into Work and Personal folders based on filenames. Files with keywords like invoice, report, meeting, project, client, proposal, contract, budget → Work. Files with keywords like vacation, photo, recipe, family, hobby, personal → Personal. Files that could be either → Review folder.",
    category: "general",
    tags: ["work", "personal", "context"],
    popularity: 0,
    isCustom: false,
  },
  // ── Professional ──────────────────────────────────────
  {
    id: "bt_legal",
    name: "Legal Case Files",
    description: "Organize as a legal filing system by client/case",
    icon: "⚖️",
    prompt: "Organize as a legal filing system: create folders by client or case name (infer from filenames). Within each, create subfolders: Pleadings, Correspondence, Discovery, Research, Contracts, and Miscellaneous. Sort by filename keywords and file type.",
    category: "professional",
    tags: ["legal", "case", "client", "law"],
    popularity: 0,
    isCustom: false,
  },
  {
    id: "bt_accounting",
    name: "Accounting / Tax Season",
    description: "Organize for tax prep and accounting by client",
    icon: "🧾",
    prompt: "Organize for tax/accounting: create folders by client name (infer from filenames) → within each: Tax Returns, Financial Statements, Receipts & Invoices, Correspondence, and Supporting Documents. Sort by keywords and file type.",
    category: "professional",
    tags: ["accounting", "tax", "finance", "client"],
    popularity: 0,
    isCustom: false,
  },
  {
    id: "bt_medical",
    name: "Medical Records",
    description: "Organize as patient records by patient name/ID",
    icon: "🏥",
    prompt: "Organize as patient records: group by patient name or ID (infer from filenames). Within each: Clinical Notes, Lab Results, Imaging, Consent Forms, Insurance, and Correspondence. Sort by keywords, dates, and file type.",
    category: "professional",
    tags: ["medical", "patient", "health", "records"],
    popularity: 0,
    isCustom: false,
  },
  {
    id: "bt_real_estate",
    name: "Real Estate",
    description: "Organize real estate transaction files by property",
    icon: "🏠",
    prompt: "Organize by property or deal: create folders by address or client name (from filenames). Within each: Contracts, Inspection Reports, Title Documents, Photos, Correspondence, and Financial. Sort by keywords and file type.",
    category: "professional",
    tags: ["real estate", "property", "transaction"],
    popularity: 0,
    isCustom: false,
  },
  // ── Creative ──────────────────────────────────────────
  {
    id: "bt_video_production",
    name: "Video Production",
    description: "Organize as a post-production project folder",
    icon: "🎬",
    prompt: "Organize as a post-production project: Raw Footage (mp4, mov, mxf), Audio (wav, mp3, aiff), Graphics & Assets (psd, ai, png, svg), Project Files (prproj, aep, fcpx), Exports & Finals (mp4, mov in export-named files), and Documents (scripts, briefs, call sheets — pdf, doc, txt).",
    category: "creative",
    tags: ["video", "film", "production", "editing"],
    popularity: 0,
    isCustom: false,
  },
  {
    id: "bt_design_project",
    name: "Design Project",
    description: "Organize as a design project with source, exports, and references",
    icon: "🎨",
    prompt: "Organize as a design project: Source Files (psd, ai, sketch, fig, xd), Exports (png, jpg, svg, pdf), References & Inspiration (images not created by user — stock photos, screenshots, mood boards), Fonts (ttf, otf, woff), and Documents (briefs, feedback, specs).",
    category: "creative",
    tags: ["design", "graphic", "ui", "creative"],
    popularity: 0,
    isCustom: false,
  },
  // ── Development ───────────────────────────────────────
  {
    id: "bt_code_cleanup",
    name: "Code Project Cleanup",
    description: "Group loose code files by programming language",
    icon: "💻",
    prompt: "Organize loose code files: group by language — Python (.py), JavaScript (.js, .jsx, .ts, .tsx), HTML/CSS (.html, .css, .scss), Config (.json, .yaml, .yml, .toml, .env), Shell Scripts (.sh, .bash), and Data (.csv, .sql, .json data files). Put README and docs in a Documentation folder.",
    category: "development",
    tags: ["code", "programming", "language", "dev"],
    popularity: 0,
    isCustom: false,
  },
  {
    id: "bt_downloaded_assets",
    name: "Downloaded Assets",
    description: "Sort developer downloaded assets by type",
    icon: "📦",
    prompt: "Sort downloaded assets: Libraries & Packages (zip/tar containing code), Fonts (ttf, otf, woff), Icons & UI Kits (svg, png sets), Mockups (psd, sketch, fig), Documentation (pdf, md), and Installers (dmg, exe, msi, deb, AppImage).",
    category: "development",
    tags: ["assets", "downloads", "libraries", "fonts"],
    popularity: 0,
    isCustom: false,
  },
];

// ── Storage ────────────────────────────────────────────────────

function customPath(): string {
  return path.join(app.getPath("userData"), "custom_templates.json");
}

function usagePath(): string {
  return path.join(app.getPath("userData"), "template_usage.json");
}

async function loadCustomTemplates(): Promise<OrganizationTemplate[]> {
  try {
    const raw = await fsp.readFile(customPath(), "utf-8");
    return JSON.parse(raw) as OrganizationTemplate[];
  } catch {
    return [];
  }
}

async function saveCustomTemplates(templates: OrganizationTemplate[]): Promise<void> {
  await fsp.writeFile(customPath(), JSON.stringify(templates, null, 2), "utf-8");
}

async function loadUsage(): Promise<Record<string, number>> {
  try {
    const raw = await fsp.readFile(usagePath(), "utf-8");
    return JSON.parse(raw) as Record<string, number>;
  } catch {
    return {};
  }
}

async function saveUsage(usage: Record<string, number>): Promise<void> {
  await fsp.writeFile(usagePath(), JSON.stringify(usage), "utf-8");
}

// ── Public API ─────────────────────────────────────────────────

/**
 * Get all templates (built-in + custom), sorted by popularity desc.
 */
export async function getAllTemplates(
  category?: TemplateCategory
): Promise<OrganizationTemplate[]> {
  const usage = await loadUsage();
  const custom = await loadCustomTemplates();

  const all = [
    ...BUILTIN_TEMPLATES.map((t) => ({ ...t, popularity: usage[t.id] ?? 0 })),
    ...custom.map((t) => ({ ...t, popularity: usage[t.id] ?? 0 })),
  ];

  const filtered = category ? all.filter((t) => t.category === category) : all;
  return filtered.sort((a, b) => b.popularity - a.popularity);
}

/**
 * Increment popularity counter for a template.
 */
export async function recordTemplateUse(templateId: string): Promise<void> {
  const usage = await loadUsage();
  usage[templateId] = (usage[templateId] ?? 0) + 1;
  await saveUsage(usage);
}

/**
 * Save a user-created custom template.
 */
export async function saveCustomTemplate(
  name: string,
  prompt: string,
  icon: string,
  category: TemplateCategory
): Promise<OrganizationTemplate> {
  const custom = await loadCustomTemplates();
  const id = `ct_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const template: OrganizationTemplate = {
    id,
    name,
    description: prompt.slice(0, 80) + (prompt.length > 80 ? "…" : ""),
    icon,
    prompt,
    category,
    tags: [],
    popularity: 0,
    isCustom: true,
  };
  custom.push(template);
  await saveCustomTemplates(custom);
  return template;
}

/**
 * Delete a custom template by ID.
 */
export async function deleteCustomTemplate(id: string): Promise<boolean> {
  const custom = await loadCustomTemplates();
  const initial = custom.length;
  const filtered = custom.filter((t) => t.id !== id);
  if (filtered.length === initial) return false;
  await saveCustomTemplates(filtered);
  return true;
}
