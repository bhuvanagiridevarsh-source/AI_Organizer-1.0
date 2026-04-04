#!/usr/bin/env python3
"""
collect_training_data.py — Training data pipeline for AI Organizer fine-tuning.

Expanded to 100+ categories covering all major occupations and life situations.
Combines real API sources (arXiv, PubMed, Wikipedia, Gutenberg, Semantic Scholar,
SEC EDGAR, CourtListener) with Ollama synthetic generation for categories without
dedicated API sources.

Outputs:
  training_data/raw_documents.jsonl    — one doc per line (with filename field)
  training_data/finetune_ready.jsonl   — Unsloth conversations format
  training_data/retrieval_ready.jsonl  — Q&A retrieval training pairs

Usage:
  python collect_training_data.py               # run all categories
  python collect_training_data.py --resume      # skip categories already collected
  python collect_training_data.py --cat "Math,Science"   # specific categories
  python collect_training_data.py --notebook    # only create FINETUNE_COLAB.ipynb
  python collect_training_data.py --retrieval   # only generate Q&A pairs
"""

import argparse
import json
import os
import re
import sys
import time
import random
import xml.etree.ElementTree as ET
from collections import Counter
from pathlib import Path
from urllib.request import urlopen, Request
from urllib.error import URLError, HTTPError
from urllib.parse import urlencode, quote_plus

# ── Configuration ──────────────────────────────────────────────────────────

RATE_LIMIT      = 0.5
MAX_WORDS       = 350
OUTPUT_DIR      = Path("training_data")
RAW_FILE        = OUTPUT_DIR / "raw_documents.jsonl"
FINETUNE_FILE   = OUTPUT_DIR / "finetune_ready.jsonl"
RETRIEVAL_FILE  = OUTPUT_DIR / "retrieval_ready.jsonl"
NOTEBOOK_FILE   = OUTPUT_DIR / "FINETUNE_COLAB.ipynb"

OLLAMA_URL      = "http://localhost:11434/api/generate"
OLLAMA_TAGS_URL = "http://localhost:11434/api/tags"
OLLAMA_MODEL    = "llama3.2"
SYNTHETIC_RATIO = 0.40   # fill up to 40% with synthetic when API source exists
RETRIEVAL_PER_CAT = 50   # Q&A pairs per category

# ── TARGETS: 100+ Category Taxonomy ────────────────────────────────────────

TARGETS = {
    # ── Student / Education (23) ──────────────────────────────────────────
    "Math":                          300,
    "Science":                       300,
    "History":                       300,
    "English/Literature":            300,
    "Computer Science":              300,
    "AP Seminar/Academic Research":  300,
    "Biology":                       300,
    "Chemistry":                     300,
    "Physics":                       300,
    "Statistics":                    300,
    "Foreign Language":              300,
    "Music Theory":                  300,
    "Art/Design":                    300,
    "Environmental Science":         300,
    "Psychology":                    300,
    "Philosophy":                    300,
    "Sociology":                     300,
    "Political Science":             300,
    "Geography":                     300,
    "Economics":                     300,
    "Study Notes":                   300,
    "Physical Education":            300,
    "Religious Studies":             300,
    # ── Healthcare (14) ───────────────────────────────────────────────────
    "Medical Records":               300,
    "Clinical Research":             300,
    "Nursing Notes":                 300,
    "Prescriptions/Medications":     300,
    "Radiology/Imaging":             300,
    "Patient Forms":                 300,
    "Medical Billing":               300,
    "Healthcare Compliance":         300,
    "Mental Health/Therapy":         300,
    "Pediatrics":                    300,
    "Nutrition/Diet":                300,
    "Medical Education":             300,
    "Public Health":                 300,
    "Surgical Procedures":           300,
    # ── Legal (12) ────────────────────────────────────────────────────────
    "Contracts":                     300,
    "Court Documents":               300,
    "Legal Research":                300,
    "Real Estate Law":               300,
    "Corporate Law":                 300,
    "Criminal Law":                  300,
    "Immigration Law":               300,
    "Intellectual Property":         300,
    "Wills/Trusts/Estate":           300,
    "Employment Law":                300,
    "Family Law":                    300,
    "Regulatory Compliance":         300,
    # ── Finance (13) ──────────────────────────────────────────────────────
    "Personal Finance":              300,
    "Investment Portfolio":          300,
    "Tax Documents":                 300,
    "Banking/Statements":            300,
    "Accounting":                    300,
    "Financial Planning":            300,
    "Mortgage/Loans":                300,
    "Insurance":                     300,
    "Cryptocurrency":                300,
    "Corporate Finance":             300,
    "Retirement Planning":           300,
    "Real Estate Investment":        300,
    "Stock Market":                  300,
    # ── Engineering (8) ───────────────────────────────────────────────────
    "Mechanical Engineering":        300,
    "Civil Engineering":             300,
    "Electrical Engineering":        300,
    "Software Engineering":          300,
    "Chemical Engineering":          300,
    "Aerospace Engineering":         300,
    "Environmental Engineering":     300,
    "Industrial Engineering":        300,
    # ── Business (12) ─────────────────────────────────────────────────────
    "Business Strategy":             300,
    "Marketing/Advertising":         300,
    "Sales/CRM":                     300,
    "Human Resources":               300,
    "Project Management":            300,
    "Operations Management":         300,
    "Supply Chain":                  300,
    "Business Analytics":            300,
    "Entrepreneurship":              300,
    "Customer Service":              300,
    "Corporate Communications":      300,
    "Meeting Notes":                 300,
    # ── Real Estate (8) ───────────────────────────────────────────────────
    "Property Listings":             300,
    "Lease Agreements":              300,
    "Purchase Contracts":            300,
    "Home Inspection":               300,
    "Appraisal Reports":             300,
    "Property Management":           300,
    "HOA Documents":                 300,
    "Real Estate Marketing":         300,
    # ── Creative / Media (10) ─────────────────────────────────────────────
    "Creative Writing":              300,
    "Screenplays/Scripts":           300,
    "Photography/Videography":       300,
    "Music/Lyrics":                  300,
    "Graphic Design":                300,
    "Journalism":                    300,
    "Podcast/Transcripts":           300,
    "Social Media Content":          300,
    "Animation/Game Design":         300,
    "Art Portfolio":                 300,
    # ── Personal Life (14) ────────────────────────────────────────────────
    "Personal Journal":              300,
    "Travel Plans":                  300,
    "Recipes/Cooking":               300,
    "Health/Fitness":                300,
    "Personal Letters":              300,
    "Hobbies/Collections":           300,
    "Home Improvement":              300,
    "Vehicle/Auto":                  300,
    "Pet Care":                      300,
    "Wedding/Events":                300,
    "Shopping/Wishlists":            300,
    "Personal Goals":                300,
    "Family Photos/Events":          300,
    "Memories/Scrapbook":            300,
    # ── IT / Cybersecurity (10) ───────────────────────────────────────────
    "Network Administration":        300,
    "System Administration":         300,
    "Cybersecurity":                 300,
    "Cloud Infrastructure":          300,
    "DevOps":                        300,
    "Database Administration":       300,
    "API Documentation":             300,
    "IT Support":                    300,
    "Data Science":                  300,
    "Software Development":          300,
    # ── Research / Academia (7) ───────────────────────────────────────────
    "Research Papers":               300,
    "Lab Reports":                   300,
    "Literature Review":             300,
    "Grant Proposals":               300,
    "Conference Papers":             300,
    "Academic CV":                   300,
    "Research Data":                 300,
    # ── Government (8) ────────────────────────────────────────────────────
    "Government Regulations":        300,
    "Policy Documents":              300,
    "Public Records":                300,
    "Military/Defense":              300,
    "Municipal Government":          300,
    "Legislative Bills":             300,
    "Government Contracts":          300,
    "Census/Statistics":             300,
    # ── Trades (8) ────────────────────────────────────────────────────────
    "Plumbing":                      300,
    "Electrical Work":               300,
    "Carpentry/Construction":        300,
    "HVAC":                          300,
    "Automotive Repair":             300,
    "Landscaping":                   300,
    "Welding/Fabrication":           300,
    "General Contractor":            300,
}

ALL_CATEGORIES = list(TARGETS.keys())

# ── Reasoning Templates ────────────────────────────────────────────────────

REASONING: dict[str, str] = {
    "Math":                         "This document contains mathematical concepts, equations, theorems, or formal proofs.",
    "Science":                      "This content covers scientific research, experimental methodology, or natural phenomena.",
    "History":                      "This document describes historical events, figures, or time periods from the past.",
    "English/Literature":           "This is a literary work containing narrative prose, poetic language, or literary analysis.",
    "Computer Science":             "This document discusses computing concepts, algorithms, software systems, or programming.",
    "AP Seminar/Academic Research": "This is a scholarly research document employing academic methodology and citation practice.",
    "Biology":                      "This document covers biological sciences including cellular processes, genetics, or ecology.",
    "Chemistry":                    "This content addresses chemical reactions, molecular structures, or laboratory chemistry.",
    "Physics":                      "This document discusses physical laws, mechanics, thermodynamics, or quantum phenomena.",
    "Statistics":                   "This content involves statistical analysis, probability theory, or data interpretation.",
    "Foreign Language":             "This document contains foreign language learning material, grammar, or translation content.",
    "Music Theory":                 "This content covers musical notation, harmony, rhythm, or music theory concepts.",
    "Art/Design":                   "This document relates to visual arts, design principles, or artistic techniques.",
    "Environmental Science":        "This content covers environmental systems, climate science, or ecological impacts.",
    "Psychology":                   "This document addresses psychological theories, human behavior, or mental processes.",
    "Philosophy":                   "This content explores philosophical arguments, ethics, logic, or metaphysical questions.",
    "Sociology":                    "This document covers social structures, cultural phenomena, or sociological research.",
    "Political Science":            "This content addresses government systems, political theory, or policy analysis.",
    "Geography":                    "This document covers physical or human geography, maps, or spatial analysis.",
    "Economics":                    "This content addresses economic theory, market analysis, or macroeconomic policy.",
    "Study Notes":                  "This appears to be student study notes, flashcards, or exam preparation material.",
    "Physical Education":           "This document covers sports, physical fitness, exercise physiology, or health education.",
    "Religious Studies":            "This content explores religious texts, theological concepts, or comparative religion.",
    "Medical Records":              "This document contains patient health information, clinical notes, or medical history.",
    "Clinical Research":            "This is a clinical study or medical research document with patient data and outcomes.",
    "Nursing Notes":                "This document contains nursing assessments, care plans, or clinical observations.",
    "Prescriptions/Medications":    "This content relates to prescription drugs, dosage instructions, or pharmacology.",
    "Radiology/Imaging":            "This document contains radiology reports, imaging findings, or diagnostic imaging data.",
    "Patient Forms":                "This is a patient intake form, consent document, or medical questionnaire.",
    "Medical Billing":              "This document contains medical billing codes, insurance claims, or reimbursement data.",
    "Healthcare Compliance":        "This content addresses healthcare regulations, HIPAA compliance, or accreditation standards.",
    "Mental Health/Therapy":        "This document covers mental health treatment, therapy notes, or psychological assessment.",
    "Pediatrics":                   "This content relates to pediatric medicine, child health, or developmental care.",
    "Nutrition/Diet":               "This document covers nutritional science, dietary plans, or food composition data.",
    "Medical Education":            "This is a medical textbook excerpt, lecture notes, or clinical training material.",
    "Public Health":                "This content addresses population health, epidemiology, or public health interventions.",
    "Surgical Procedures":          "This document describes surgical techniques, operative reports, or procedural guidelines.",
    "Contracts":                    "This is a legal contract containing terms, obligations, and binding agreements.",
    "Court Documents":              "This document is a court filing, legal brief, or judicial proceeding record.",
    "Legal Research":               "This content involves legal case analysis, statutory interpretation, or legal precedent.",
    "Real Estate Law":              "This document addresses real estate transactions, property law, or title issues.",
    "Corporate Law":                "This content covers corporate governance, securities law, or business entity regulation.",
    "Criminal Law":                 "This document involves criminal statutes, case law, or criminal procedure.",
    "Immigration Law":              "This content addresses immigration regulations, visa procedures, or citizenship law.",
    "Intellectual Property":        "This document covers patents, trademarks, copyrights, or trade secrets.",
    "Wills/Trusts/Estate":          "This is an estate planning document including wills, trusts, or probate matters.",
    "Employment Law":               "This content addresses labor law, employment contracts, or workplace regulations.",
    "Family Law":                   "This document covers divorce, child custody, adoption, or domestic relations.",
    "Regulatory Compliance":        "This content addresses regulatory requirements, compliance programs, or audit procedures.",
    "Personal Finance":             "This document covers personal budgeting, savings strategies, or household finances.",
    "Investment Portfolio":         "This content details investment holdings, portfolio allocation, or asset performance.",
    "Tax Documents":                "This is a tax return, tax form, or tax planning document.",
    "Banking/Statements":           "This document is a bank statement, account summary, or banking correspondence.",
    "Accounting":                   "This content covers bookkeeping, financial statements, or accounting procedures.",
    "Financial Planning":           "This document addresses financial goals, wealth management, or financial advisory content.",
    "Mortgage/Loans":               "This content relates to mortgage applications, loan terms, or debt management.",
    "Insurance":                    "This document covers insurance policies, claims, or coverage analysis.",
    "Cryptocurrency":               "This content addresses blockchain technology, crypto assets, or digital currency.",
    "Corporate Finance":            "This document covers corporate financial analysis, capital structure, or M&A activity.",
    "Retirement Planning":          "This content addresses retirement savings, pension plans, or 401(k) strategies.",
    "Real Estate Investment":       "This document covers real estate investment analysis, ROI, or property acquisition.",
    "Stock Market":                 "This content involves stock trading, equity analysis, or market commentary.",
    "Mechanical Engineering":       "This document covers mechanical systems, machine design, or thermodynamic analysis.",
    "Civil Engineering":            "This content addresses structural design, infrastructure, or construction engineering.",
    "Electrical Engineering":       "This document covers electrical circuits, power systems, or electronics engineering.",
    "Software Engineering":         "This content involves software design patterns, system architecture, or code review.",
    "Chemical Engineering":         "This document covers chemical process design, reaction engineering, or plant operations.",
    "Aerospace Engineering":        "This content addresses aerodynamics, propulsion systems, or spacecraft design.",
    "Environmental Engineering":    "This document covers environmental remediation, waste management, or pollution control.",
    "Industrial Engineering":       "This content addresses process optimization, lean manufacturing, or operations research.",
    "Business Strategy":            "This document covers strategic planning, competitive analysis, or corporate direction.",
    "Marketing/Advertising":        "This content relates to marketing campaigns, brand strategy, or advertising copy.",
    "Sales/CRM":                    "This document covers sales processes, customer relationship management, or pipeline tracking.",
    "Human Resources":              "This content addresses HR policies, employee management, or talent acquisition.",
    "Project Management":           "This document covers project plans, timelines, milestones, or resource allocation.",
    "Operations Management":        "This content addresses operational workflows, process improvement, or capacity planning.",
    "Supply Chain":                 "This document covers logistics, procurement, inventory management, or supplier relations.",
    "Business Analytics":           "This content involves business data analysis, KPIs, dashboards, or reporting.",
    "Entrepreneurship":             "This document covers startup strategy, business models, or founder decision-making.",
    "Customer Service":             "This content addresses customer support procedures, service standards, or issue resolution.",
    "Corporate Communications":     "This is an internal memo, press release, executive communication, or company announcement.",
    "Meeting Notes":                "This document contains meeting agendas, minutes, action items, or discussion summaries.",
    "Property Listings":            "This is a real estate listing with property description, features, and pricing.",
    "Lease Agreements":             "This document is a rental lease or commercial tenancy agreement.",
    "Purchase Contracts":           "This is a real estate purchase agreement or property sale contract.",
    "Home Inspection":              "This document is a home inspection report detailing property conditions and defects.",
    "Appraisal Reports":            "This content is a property appraisal report with valuation analysis.",
    "Property Management":          "This document covers property maintenance, tenant relations, or building management.",
    "HOA Documents":                "This content is from a homeowners association covering rules, fees, or governance.",
    "Real Estate Marketing":        "This is real estate marketing material including brochures, listings, or promotional content.",
    "Creative Writing":             "This is a work of fiction, short story, or creative narrative prose.",
    "Screenplays/Scripts":          "This document is a screenplay, stage play, or dialogue script.",
    "Photography/Videography":      "This content covers photography techniques, video production, or visual media.",
    "Music/Lyrics":                 "This document contains song lyrics, musical compositions, or performance notes.",
    "Graphic Design":               "This content relates to graphic design projects, visual design, or branding work.",
    "Journalism":                   "This is a news article, investigative report, or journalistic piece.",
    "Podcast/Transcripts":          "This document is a podcast episode transcript or audio content record.",
    "Social Media Content":         "This content is social media posts, content calendar entries, or platform copy.",
    "Animation/Game Design":        "This document covers animation scripts, game design documents, or interactive media.",
    "Art Portfolio":                "This content describes artworks, artist statements, or portfolio documentation.",
    "Personal Journal":             "This is a personal diary entry, journal writing, or private reflection.",
    "Travel Plans":                 "This document contains travel itineraries, booking confirmations, or trip planning notes.",
    "Recipes/Cooking":              "This content contains recipes, cooking instructions, or food preparation guides.",
    "Health/Fitness":               "This document covers workout plans, fitness tracking, or personal health goals.",
    "Personal Letters":             "This is personal correspondence, a letter to a friend or family member.",
    "Hobbies/Collections":          "This content relates to a hobby, collection, or personal interest activity.",
    "Home Improvement":             "This document covers home renovation projects, repairs, or DIY instructions.",
    "Vehicle/Auto":                 "This content addresses vehicle maintenance, car purchases, or automotive service records.",
    "Pet Care":                     "This document covers pet health, veterinary records, or animal care instructions.",
    "Wedding/Events":               "This content is event planning material for weddings, parties, or special occasions.",
    "Shopping/Wishlists":           "This document is a shopping list, purchase wishlist, or product comparison.",
    "Personal Goals":               "This content contains personal goal-setting, habit tracking, or self-improvement plans.",
    "Family Photos/Events":         "This document describes family events, photo albums, or personal memory records.",
    "Memories/Scrapbook":           "This is a scrapbook entry, memory journal, or personal historical record.",
    "Network Administration":       "This document covers network configuration, topology diagrams, or infrastructure documentation.",
    "System Administration":        "This content addresses server management, OS configuration, or system maintenance.",
    "Cybersecurity":                "This document covers security policies, vulnerability assessments, or incident reports.",
    "Cloud Infrastructure":         "This content addresses cloud architecture, IaaS/PaaS/SaaS deployments, or cloud cost management.",
    "DevOps":                       "This document covers CI/CD pipelines, deployment automation, or infrastructure-as-code.",
    "Database Administration":      "This content covers database design, query optimization, or DBA procedures.",
    "API Documentation":            "This is API reference documentation, endpoint descriptions, or integration guides.",
    "IT Support":                   "This document is an IT support ticket, helpdesk procedure, or troubleshooting guide.",
    "Data Science":                 "This content covers data analysis, machine learning models, or data visualization.",
    "Software Development":         "This document contains code documentation, developer guides, or technical specifications.",
    "Research Papers":              "This is an academic research paper with abstract, methodology, and conclusions.",
    "Lab Reports":                  "This document is a laboratory experiment report with methods, results, and analysis.",
    "Literature Review":            "This content is a systematic literature review summarizing existing research.",
    "Grant Proposals":              "This document is a research grant proposal with objectives and budget justification.",
    "Conference Papers":            "This is a conference proceedings paper or academic presentation abstract.",
    "Academic CV":                  "This document is an academic curriculum vitae listing publications and research.",
    "Research Data":                "This content contains research datasets, data dictionaries, or experimental measurements.",
    "Government Regulations":       "This document contains government regulations, rules, or administrative law.",
    "Policy Documents":             "This content is a policy brief, government white paper, or official policy statement.",
    "Public Records":               "This document is a public record, FOIA request response, or government disclosure.",
    "Military/Defense":             "This content addresses military operations, defense procurement, or national security.",
    "Municipal Government":         "This document covers local government operations, city planning, or municipal services.",
    "Legislative Bills":            "This is legislative text, a bill, or statute under consideration or enacted into law.",
    "Government Contracts":         "This document is a government procurement contract, RFP, or federal award document.",
    "Census/Statistics":            "This content contains census data, demographic statistics, or government surveys.",
    "Plumbing":                     "This document covers plumbing installation, pipe diagrams, or plumbing repair procedures.",
    "Electrical Work":              "This content addresses electrical wiring, load calculations, or electrical code compliance.",
    "Carpentry/Construction":       "This document covers carpentry techniques, construction plans, or building methods.",
    "HVAC":                         "This content addresses heating, ventilation, air conditioning installation or maintenance.",
    "Automotive Repair":            "This document covers vehicle diagnostics, repair procedures, or mechanic work orders.",
    "Landscaping":                  "This content covers landscaping design, plant care, or grounds maintenance procedures.",
    "Welding/Fabrication":          "This document covers welding techniques, metal fabrication, or structural joining.",
    "General Contractor":           "This is a contractor bid, project scope, subcontractor agreement, or construction invoice.",
}

SYSTEM_PROMPT = (
    "You are a file organization assistant. Given a file's name and content, and a list of "
    "available folders, choose the single best folder. Reply with only the folder name "
    "followed by a pipe character and one sentence of reasoning. Example: "
    "Math | This document contains calculus equations and derivative problems."
)

# ── HTTP Utilities ─────────────────────────────────────────────────────────

_DEFAULT_HEADERS = {
    "User-Agent": (
        "AIOrganizer-TrainingPipeline/2.0 "
        "(educational use; open-source; github.com/ai-organizer)"
    )
}

_last_request_time = 0.0


def rate_sleep() -> None:
    global _last_request_time
    elapsed = time.time() - _last_request_time
    if elapsed < RATE_LIMIT:
        time.sleep(RATE_LIMIT - elapsed)
    _last_request_time = time.time()


def fetch_url(url: str, extra_headers: dict | None = None, timeout: int = 20) -> bytes | None:
    headers = {**_DEFAULT_HEADERS, **(extra_headers or {})}
    try:
        req = Request(url, headers=headers)
        with urlopen(req, timeout=timeout) as resp:
            return resp.read()
    except Exception as exc:
        print(f"    [warn] fetch failed ({type(exc).__name__}): {url[:80]}")
        return None


def fetch_json(url: str, extra_headers: dict | None = None) -> dict | list | None:
    data = fetch_url(url, extra_headers)
    if data is None:
        return None
    try:
        return json.loads(data.decode("utf-8", errors="replace"))
    except json.JSONDecodeError:
        return None


# ── Text Utilities ─────────────────────────────────────────────────────────

_CITATION_INLINE = re.compile(r"\[\d+(?:,\s*\d+)*\]")
_CITATION_AUTHOR = re.compile(r"\([A-Z][a-z]+(?:\s+et\s+al\.?)?,\s*\d{4}[a-z]?\)")
_HTML_TAG        = re.compile(r"<[^>]+>")
_WHITESPACE      = re.compile(r"\s+")


def clean_text(text: str) -> str:
    if not text:
        return ""
    text = _CITATION_INLINE.sub("", text)
    text = _CITATION_AUTHOR.sub("", text)
    text = _HTML_TAG.sub(" ", text)
    text = _WHITESPACE.sub(" ", text).strip()
    return text


def truncate_words(text: str, n: int = MAX_WORDS) -> str:
    words = text.split()
    if len(words) <= n:
        return text
    return " ".join(words[:n]) + "..."


def make_doc(content: str, category: str, source: str, filename: str = "") -> dict | None:
    content = truncate_words(clean_text(content))
    if len(content.split()) < 25:
        return None
    doc: dict = {"content": content, "category": category, "source": source}
    if filename:
        doc["filename"] = filename
    return doc


# ── Filename Generator ─────────────────────────────────────────────────────

_FILENAME_KEYWORDS: dict[str, list[str]] = {
    "Math":                         ["calculus_notes", "algebra_hw", "proof_set", "math_exam", "problem_set", "linear_algebra", "statistics_hw", "trig_review"],
    "Science":                      ["science_notes", "experiment_report", "lab_results", "scientific_method", "chemistry_hw", "physics_problem"],
    "History":                      ["history_essay", "historical_analysis", "wwii_notes", "civil_war_study", "ancient_rome", "timeline_notes"],
    "English/Literature":           ["essay_draft", "book_report", "literary_analysis", "poetry_response", "shakespeare_notes", "reading_notes"],
    "Computer Science":             ["cs_notes", "algorithm_study", "data_structures", "programming_hw", "cs_project", "binary_tree"],
    "AP Seminar/Academic Research": ["research_paper", "annotated_bibliography", "thesis_draft", "academic_essay", "lit_review"],
    "Biology":                      ["bio_notes", "cell_biology", "genetics_study", "ecology_lab", "anatomy_notes", "bio_exam_prep"],
    "Chemistry":                    ["chem_notes", "organic_chem", "lab_report", "reaction_equations", "periodic_table_study"],
    "Physics":                      ["physics_notes", "mechanics_hw", "thermodynamics", "quantum_study", "electromagnetism"],
    "Statistics":                   ["stats_notes", "probability_hw", "regression_analysis", "stat_test_review", "data_analysis"],
    "Foreign Language":             ["spanish_vocab", "french_grammar", "language_notes", "mandarin_study", "german_homework"],
    "Music Theory":                 ["music_theory_notes", "chord_progression", "scale_study", "harmony_hw", "sight_reading"],
    "Art/Design":                   ["design_notes", "color_theory", "art_history", "portfolio_sketch", "composition_study"],
    "Environmental Science":        ["env_science_notes", "climate_study", "ecology_report", "sustainability_essay"],
    "Psychology":                   ["psych_notes", "cognitive_theory", "behavioral_study", "psych_exam_review"],
    "Philosophy":                   ["philosophy_essay", "ethics_notes", "logic_hw", "epistemology_study"],
    "Sociology":                    ["sociology_notes", "social_theory", "group_dynamics_study", "cultural_analysis"],
    "Political Science":            ["poli_sci_notes", "government_systems", "policy_analysis", "political_theory"],
    "Geography":                    ["geography_notes", "map_analysis", "human_geo", "physical_geography"],
    "Economics":                    ["economics_notes", "macro_study", "micro_hw", "econ_exam_review"],
    "Study Notes":                  ["study_guide", "flashcards", "exam_notes", "review_sheet", "cheat_sheet", "outline"],
    "Physical Education":           ["pe_notes", "fitness_plan", "sports_rules", "health_class_notes"],
    "Religious Studies":            ["religion_notes", "theology_essay", "comparative_religion", "scripture_study"],
    "Medical Records":              ["patient_chart", "medical_history", "clinical_notes", "discharge_summary", "soap_note"],
    "Clinical Research":            ["clinical_trial", "study_protocol", "patient_data", "research_findings", "irb_report"],
    "Nursing Notes":                ["nursing_assessment", "care_plan", "shift_notes", "patient_observation"],
    "Prescriptions/Medications":    ["prescription", "medication_list", "drug_dosage", "pharmacy_record", "rx_info"],
    "Radiology/Imaging":            ["radiology_report", "mri_findings", "ct_scan_report", "xray_interpretation"],
    "Patient Forms":                ["intake_form", "consent_form", "patient_questionnaire", "health_history_form"],
    "Medical Billing":              ["billing_statement", "insurance_claim", "eob", "medical_invoice", "cpt_codes"],
    "Healthcare Compliance":        ["hipaa_policy", "compliance_checklist", "accreditation_notes", "audit_report"],
    "Mental Health/Therapy":        ["therapy_notes", "session_summary", "treatment_plan", "counseling_record"],
    "Pediatrics":                   ["pediatric_notes", "child_health_record", "vaccination_record", "growth_chart"],
    "Nutrition/Diet":               ["nutrition_plan", "diet_assessment", "meal_plan", "calorie_tracker", "food_diary"],
    "Medical Education":            ["medical_lecture", "pathology_notes", "pharmacology_study", "clinical_skills"],
    "Public Health":                ["public_health_report", "epidemiology_study", "outbreak_analysis", "health_policy"],
    "Surgical Procedures":          ["operative_report", "surgical_protocol", "pre_op_checklist", "post_op_notes"],
    "Contracts":                    ["contract_draft", "service_agreement", "nda", "vendor_contract", "agreement"],
    "Court Documents":              ["complaint", "motion", "brief", "court_filing", "pleadings", "affidavit"],
    "Legal Research":               ["case_memo", "legal_brief", "statute_analysis", "case_law_summary"],
    "Real Estate Law":              ["title_opinion", "deed_review", "closing_documents", "easement_analysis"],
    "Corporate Law":                ["articles_incorporation", "bylaws", "board_resolution", "sec_filing"],
    "Criminal Law":                 ["criminal_brief", "sentencing_memo", "case_analysis", "prosecution_notes"],
    "Immigration Law":              ["visa_application", "immigration_brief", "petition_i130", "green_card_docs"],
    "Intellectual Property":        ["patent_application", "trademark_filing", "copyright_registration", "ip_memo"],
    "Wills/Trusts/Estate":          ["last_will_testament", "trust_document", "estate_plan", "probate_filing"],
    "Employment Law":               ["employment_contract", "severance_agreement", "hr_policy", "labor_memo"],
    "Family Law":                   ["divorce_petition", "custody_agreement", "child_support_order", "separation"],
    "Regulatory Compliance":        ["compliance_report", "regulatory_audit", "policy_manual", "risk_assessment"],
    "Personal Finance":             ["budget_spreadsheet", "monthly_expenses", "savings_tracker", "net_worth"],
    "Investment Portfolio":         ["portfolio_summary", "investment_statement", "asset_allocation", "holdings"],
    "Tax Documents":                ["tax_return_2024", "w2_form", "1099_form", "tax_deductions", "irs_filing"],
    "Banking/Statements":           ["bank_statement", "checking_account", "account_summary", "transaction_history"],
    "Accounting":                   ["income_statement", "balance_sheet", "general_ledger", "accounts_payable"],
    "Financial Planning":           ["financial_plan", "wealth_management", "cash_flow_projection", "goals_tracker"],
    "Mortgage/Loans":               ["mortgage_application", "loan_terms", "amortization_schedule", "refinance"],
    "Insurance":                    ["insurance_policy", "coverage_summary", "claim_form", "premium_statement"],
    "Cryptocurrency":               ["crypto_portfolio", "bitcoin_analysis", "defi_notes", "blockchain_research"],
    "Corporate Finance":            ["earnings_report", "financial_model", "dcf_analysis", "capital_structure"],
    "Retirement Planning":          ["retirement_plan", "401k_statement", "ira_contribution", "pension_summary"],
    "Real Estate Investment":       ["investment_analysis", "cap_rate_calculation", "rental_property", "roi_model"],
    "Stock Market":                 ["stock_analysis", "market_research", "equity_report", "trading_notes"],
    "Mechanical Engineering":       ["design_spec", "cad_notes", "stress_analysis", "engineering_report"],
    "Civil Engineering":            ["structural_analysis", "site_plan", "geotechnical_report", "load_calculation"],
    "Electrical Engineering":       ["circuit_design", "power_analysis", "pcb_schematic", "electrical_spec"],
    "Software Engineering":         ["system_design", "architecture_doc", "code_review", "technical_spec"],
    "Chemical Engineering":         ["process_design", "reaction_kinetics", "plant_safety", "mass_balance"],
    "Aerospace Engineering":        ["aerodynamic_analysis", "propulsion_design", "flight_test_report"],
    "Environmental Engineering":    ["environmental_impact", "remediation_plan", "emissions_report"],
    "Industrial Engineering":       ["process_flowchart", "efficiency_analysis", "lean_implementation"],
    "Business Strategy":            ["strategic_plan", "competitive_analysis", "business_roadmap", "swot_analysis"],
    "Marketing/Advertising":        ["marketing_plan", "campaign_brief", "brand_guidelines", "ad_copy"],
    "Sales/CRM":                    ["sales_report", "crm_notes", "pipeline_tracker", "account_summary"],
    "Human Resources":              ["hr_policy", "performance_review", "job_description", "onboarding_guide"],
    "Project Management":           ["project_plan", "gantt_chart", "status_report", "project_brief"],
    "Operations Management":        ["operations_manual", "sop_document", "process_guide", "kpi_report"],
    "Supply Chain":                 ["supplier_contract", "inventory_report", "logistics_plan", "procurement"],
    "Business Analytics":           ["analytics_report", "dashboard_notes", "data_insights", "kpi_analysis"],
    "Entrepreneurship":             ["business_plan", "pitch_deck", "startup_notes", "mvp_plan"],
    "Customer Service":             ["customer_report", "service_guide", "complaint_log", "support_sop"],
    "Corporate Communications":     ["press_release", "internal_memo", "executive_update", "company_announcement"],
    "Meeting Notes":                ["meeting_minutes", "action_items", "agenda", "team_meeting_notes"],
    "Property Listings":            ["property_listing", "mls_description", "listing_sheet", "home_for_sale"],
    "Lease Agreements":             ["lease_agreement", "rental_contract", "tenancy_agreement", "sublease"],
    "Purchase Contracts":           ["purchase_agreement", "offer_to_purchase", "sales_contract", "psa"],
    "Home Inspection":              ["inspection_report", "home_inspection", "property_condition", "defect_list"],
    "Appraisal Reports":            ["appraisal_report", "property_valuation", "market_analysis", "comp_report"],
    "Property Management":          ["maintenance_log", "tenant_communication", "property_report", "rent_roll"],
    "HOA Documents":                ["hoa_rules", "cc_and_r", "hoa_meeting_minutes", "assessment_notice"],
    "Real Estate Marketing":        ["listing_brochure", "open_house_flyer", "neighborhood_guide", "marketing_copy"],
    "Creative Writing":             ["short_story", "fiction_draft", "novel_chapter", "flash_fiction"],
    "Screenplays/Scripts":          ["screenplay_draft", "script_v2", "scene_outline", "pilot_script"],
    "Photography/Videography":      ["shoot_notes", "video_script", "photography_guide", "editing_notes"],
    "Music/Lyrics":                 ["song_lyrics", "verse_draft", "album_notes", "lyric_sheet"],
    "Graphic Design":               ["design_brief", "style_guide", "logo_concepts", "mockup_notes"],
    "Journalism":                   ["article_draft", "news_story", "interview_notes", "feature_piece"],
    "Podcast/Transcripts":          ["episode_transcript", "podcast_script", "interview_transcript"],
    "Social Media Content":         ["social_posts", "content_calendar", "caption_copy", "ig_captions"],
    "Animation/Game Design":        ["game_design_doc", "animation_script", "character_notes", "level_design"],
    "Art Portfolio":                ["artist_statement", "portfolio_notes", "exhibition_description"],
    "Personal Journal":             ["journal_entry", "diary", "daily_notes", "reflection"],
    "Travel Plans":                 ["travel_itinerary", "trip_plan", "vacation_notes", "booking_info"],
    "Recipes/Cooking":              ["recipe", "cooking_notes", "meal_prep", "dinner_plan"],
    "Health/Fitness":               ["workout_plan", "fitness_log", "exercise_routine", "training_notes"],
    "Personal Letters":             ["letter_to_friend", "personal_note", "correspondence"],
    "Hobbies/Collections":          ["collection_list", "hobby_notes", "stamp_collection", "reading_list"],
    "Home Improvement":             ["renovation_plan", "diy_project", "home_repair_notes", "contractor_quote"],
    "Vehicle/Auto":                 ["car_maintenance", "vehicle_service_log", "repair_invoice", "auto_notes"],
    "Pet Care":                     ["pet_health_record", "vet_notes", "vaccination_log", "pet_care_guide"],
    "Wedding/Events":               ["wedding_checklist", "event_plan", "venue_notes", "guest_list"],
    "Shopping/Wishlists":           ["shopping_list", "wish_list", "product_comparison", "purchase_tracker"],
    "Personal Goals":               ["goals_list", "habit_tracker", "vision_board_notes", "resolutions"],
    "Family Photos/Events":         ["family_reunion_notes", "photo_album_captions", "event_memories"],
    "Memories/Scrapbook":           ["scrapbook_entry", "memory_note", "keepsake_notes"],
    "Network Administration":       ["network_diagram", "ip_scheme", "firewall_config", "network_docs"],
    "System Administration":        ["server_config", "admin_guide", "system_notes", "maintenance_log"],
    "Cybersecurity":                ["security_policy", "pentest_report", "incident_report", "vulnerability_scan"],
    "Cloud Infrastructure":         ["cloud_architecture", "aws_setup", "terraform_notes", "infra_docs"],
    "DevOps":                       ["pipeline_config", "ci_cd_notes", "deployment_guide", "devops_runbook"],
    "Database Administration":      ["db_schema", "query_optimization", "dba_notes", "backup_procedure"],
    "API Documentation":            ["api_docs", "endpoint_reference", "swagger_notes", "integration_guide"],
    "IT Support":                   ["support_ticket", "troubleshooting_guide", "helpdesk_notes"],
    "Data Science":                 ["data_analysis", "ml_model_notes", "notebook_summary", "feature_engineering"],
    "Software Development":         ["dev_notes", "code_documentation", "technical_spec", "readme"],
    "Research Papers":              ["research_paper", "manuscript_draft", "academic_paper", "preprint"],
    "Lab Reports":                  ["lab_report", "experiment_results", "data_collection", "methods_notes"],
    "Literature Review":            ["lit_review", "systematic_review", "bibliography_notes"],
    "Grant Proposals":              ["grant_proposal", "funding_application", "research_objectives"],
    "Conference Papers":            ["conference_paper", "abstract_submission", "proceedings_draft"],
    "Academic CV":                  ["academic_cv", "curriculum_vitae", "publications_list"],
    "Research Data":                ["dataset_notes", "data_dictionary", "experimental_data"],
    "Government Regulations":       ["federal_regulation", "rule_notice", "regulatory_guidance"],
    "Policy Documents":             ["policy_brief", "white_paper", "policy_memo"],
    "Public Records":               ["foia_response", "public_record", "government_disclosure"],
    "Military/Defense":             ["defense_report", "military_brief", "operations_order"],
    "Municipal Government":         ["city_council_minutes", "municipal_ordinance", "zoning_report"],
    "Legislative Bills":            ["bill_text", "legislative_summary", "amendment_notes"],
    "Government Contracts":         ["rfp_response", "federal_contract", "procurement_award"],
    "Census/Statistics":            ["census_data", "demographic_report", "statistics_summary"],
    "Plumbing":                     ["plumbing_diagram", "pipe_spec", "repair_estimate", "inspection_notes"],
    "Electrical Work":              ["wiring_diagram", "electrical_permit", "load_calculation", "service_panel"],
    "Carpentry/Construction":       ["construction_plan", "framing_notes", "material_list", "bid_sheet"],
    "HVAC":                         ["hvac_design", "duct_layout", "equipment_spec", "maintenance_schedule"],
    "Automotive Repair":            ["repair_order", "diagnostic_report", "service_estimate", "parts_list"],
    "Landscaping":                  ["landscape_plan", "planting_guide", "maintenance_schedule", "design_proposal"],
    "Welding/Fabrication":          ["weld_spec", "fabrication_drawing", "material_cert", "wps_procedure"],
    "General Contractor":           ["bid_proposal", "scope_of_work", "change_order", "subcontractor_agreement"],
}

_CATEGORY_EXTENSIONS: dict[str, list[str]] = {
    "Math":                         [".pdf", ".docx", ".txt"],
    "Science":                      [".pdf", ".docx", ".txt"],
    "History":                      [".pdf", ".docx", ".txt"],
    "English/Literature":           [".pdf", ".docx", ".txt"],
    "Computer Science":             [".pdf", ".md", ".txt", ".docx"],
    "AP Seminar/Academic Research": [".pdf", ".docx"],
    "Biology":                      [".pdf", ".docx", ".txt"],
    "Chemistry":                    [".pdf", ".docx", ".txt"],
    "Physics":                      [".pdf", ".docx", ".txt"],
    "Statistics":                   [".pdf", ".xlsx", ".docx"],
    "Medical Records":              [".pdf", ".docx", ".txt"],
    "Clinical Research":            [".pdf", ".docx"],
    "Nursing Notes":                [".pdf", ".docx", ".txt"],
    "Prescriptions/Medications":    [".pdf", ".txt"],
    "Radiology/Imaging":            [".pdf", ".docx"],
    "Patient Forms":                [".pdf", ".docx"],
    "Medical Billing":              [".pdf", ".xlsx", ".csv"],
    "Accounting":                   [".xlsx", ".pdf", ".docx"],
    "Tax Documents":                [".pdf", ".xlsx"],
    "Banking/Statements":           [".pdf", ".csv", ".xlsx"],
    "Software Engineering":         [".md", ".pdf", ".docx", ".txt"],
    "Data Science":                 [".pdf", ".ipynb", ".md"],
    "Software Development":         [".md", ".txt", ".pdf"],
    "API Documentation":            [".md", ".pdf", ".txt"],
    "DevOps":                       [".yaml", ".md", ".pdf"],
    "Research Papers":              [".pdf", ".docx"],
    "Lab Reports":                  [".pdf", ".docx", ".txt"],
    "Screenplays/Scripts":          [".pdf", ".fdx", ".docx"],
    "Music/Lyrics":                 [".pdf", ".txt", ".docx"],
    "Social Media Content":         [".txt", ".docx", ".pdf"],
}

_DEFAULT_EXTENSIONS = [".pdf", ".docx", ".txt"]

_GENERIC_FILENAMES = [
    "document.pdf", "file.docx", "notes.txt", "report.pdf",
    "scan001.pdf", "scan_0042.pdf", "IMG_4821.pdf", "download.pdf",
    "untitled.docx", "draft.docx", "final.pdf", "Copy of document.pdf",
    "new file.txt", "misc.pdf", "temp.docx", "backup.pdf",
    "2024_file.pdf", "doc1.pdf", "notes2.docx",
]

_DATE_FORMATS = [
    "2024-{m:02d}-{d:02d}", "2023_{m:02d}{d:02d}", "{m:02d}-{d:02d}-2024",
    "Jan2024", "Feb2024", "Mar2024", "Q1_2024", "Q3_2023",
]


def generate_filename(category: str) -> str:
    """
    Generate a realistic filename for a training example.
    ~30% generic/ambiguous, ~70% category-specific with varied styles.
    """
    # 30% chance: generic / ambiguous filename
    if random.random() < 0.30:
        return random.choice(_GENERIC_FILENAMES)

    keywords = _FILENAME_KEYWORDS.get(category, ["document", "file", "notes"])
    exts     = _CATEGORY_EXTENSIONS.get(category, _DEFAULT_EXTENSIONS)
    keyword  = random.choice(keywords)
    ext      = random.choice(exts)

    style = random.choices(
        ["professional", "student", "messy", "date_prefix", "initials"],
        weights=[30, 25, 20, 15, 10]
    )[0]

    if style == "professional":
        # Clean underscore-separated professional name
        name = keyword
        if random.random() < 0.3:
            version = random.choice(["v1", "v2", "final", "FINAL", "rev2", "draft"])
            name = f"{keyword}_{version}"
        return name + ext

    elif style == "student":
        # First initial + last name style
        first  = random.choice(["J", "M", "A", "K", "S", "R", "T", "C"])
        last   = random.choice(["Smith", "Johnson", "Williams", "Brown", "Davis",
                                 "Martinez", "Chen", "Patel", "Kim", "Jones"])
        suffix = random.choice(["", "_HW", "_essay", "_notes", "_project"])
        return f"{first}{last}_{keyword}{suffix}{ext}"

    elif style == "messy":
        # Real-world messy naming with spaces or mixed case
        variants = [
            keyword.replace("_", " ") + ext,
            keyword.upper() + ext,
            keyword.replace("_", "-") + ext,
            "Copy of " + keyword.replace("_", " ") + ext,
            keyword + " (1)" + ext,
            keyword + " new" + ext,
        ]
        return random.choice(variants)

    elif style == "date_prefix":
        m = random.randint(1, 12)
        d = random.randint(1, 28)
        fmt = random.choice(_DATE_FORMATS)
        try:
            date_str = fmt.format(m=m, d=d)
        except Exception:
            date_str = f"2024_{m:02d}_{d:02d}"
        return f"{date_str}_{keyword}{ext}"

    else:  # initials
        initials = "".join(random.choices("ABCDEFGHJKLMNPRSTW", k=2))
        return f"{initials}_{keyword}{ext}"


# ── Ollama Synthetic Generator ─────────────────────────────────────────────

def check_ollama_connection() -> bool:
    """Test Ollama connection and print available models. Returns True if reachable."""
    try:
        req = Request(OLLAMA_TAGS_URL, method="GET")
        with urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            models = [m["name"] for m in data.get("models", [])]
            if models:
                print(f"  [ollama] Connected — available models: {', '.join(models)}")
                if OLLAMA_MODEL not in models and not any(m.startswith(OLLAMA_MODEL) for m in models):
                    print(f"  [ollama] WARNING: configured model '{OLLAMA_MODEL}' not found in list above.")
            else:
                print("  [ollama] Connected but no models are loaded.")
            return True
    except Exception as exc:
        print(f"  [ollama] ERROR: Cannot connect to Ollama at {OLLAMA_TAGS_URL}: {exc}")
        print("  [ollama] Synthetic generation will be skipped.")
        return False


def _call_ollama(prompt: str, timeout: int = 60) -> str | None:
    """Call local Ollama /api/generate and return the full response text."""
    payload = json.dumps({
        "model":  OLLAMA_MODEL,
        "prompt": prompt,
        "stream": False,
        "options": {"temperature": 0.85, "num_predict": 400},
    }).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    try:
        req = Request(OLLAMA_URL, data=payload, headers=headers, method="POST")
        with urlopen(req, timeout=timeout) as resp:
            result = json.loads(resp.read().decode("utf-8"))
            return result.get("response", "")
    except Exception as exc:
        print(f"    [ollama] error: {exc}")
        return None


def generate_synthetic_examples(category: str, count: int) -> list[dict]:
    """
    Generate `count` synthetic document excerpts for `category` using local Ollama.
    Returns list of doc dicts. Falls back gracefully if Ollama is unavailable.
    """
    if count <= 0:
        return []

    reasoning_hint = REASONING.get(category, f"This document belongs in the {category} folder.")
    docs: list[dict] = []
    attempts = 0
    max_attempts = count * 4   # allow retries

    print(f"    [synthetic] Generating {count} examples for '{category}' …", flush=True)

    while len(docs) < count and attempts < max_attempts:
        attempts += 1
        prompt = (
            f"Generate a realistic document excerpt (150–250 words) that belongs in "
            f"a folder called '{category}'. Context: {reasoning_hint} "
            f"The content should be authentic, use domain-specific terminology, "
            f"and read like a real document a person would actually save in that folder. "
            f"Output ONLY the document text — no JSON, no labels, no preamble."
        )
        text = _call_ollama(prompt)
        if not text or len(text.split()) < 30:
            continue

        filename = generate_filename(category)
        d = make_doc(text, category, "ollama_synthetic", filename)
        if d:
            docs.append(d)
            if len(docs) % 20 == 0:
                print(f"      … {len(docs)}/{count}", flush=True)

    if len(docs) < count:
        print(f"    [synthetic] Warning: only generated {len(docs)}/{count} for '{category}'")

    return docs[:count]


# ── Fetcher: arXiv ────────────────────────────────────────────────────────

_ARXIV_ATOM = "http://export.arxiv.org/api/query"
_ARXIV_NS   = {"a": "http://www.w3.org/2005/Atom"}

_ARXIV_SUBJECTS: dict[str, list[str]] = {
    "Math":               ["math.AG", "math.NT", "math.CA", "math.CO", "math.PR", "math.ST", "math.AP", "math.GR", "math.DS"],
    "Computer Science":   ["cs.AI", "cs.LG", "cs.CV", "cs.PL", "cs.SE", "cs.DS", "cs.NI", "cs.HC", "cs.CR", "cs.IR"],
    "Statistics":         ["stat.ML", "stat.ME", "stat.AP", "stat.TH", "stat.CO"],
    "Physics":            ["physics.gen-ph", "cond-mat.stat-mech", "quant-ph", "physics.comp-ph", "hep-th"],
    "Biology":            ["q-bio.BM", "q-bio.CB", "q-bio.GN", "q-bio.PE", "q-bio.NC"],
    "Environmental Science": ["physics.ao-ph", "q-bio.PE", "physics.geo-ph"],
    "Data Science":       ["cs.LG", "stat.ML", "cs.AI", "cs.IR"],
    "Cybersecurity":      ["cs.CR", "cs.NI"],
    "Software Engineering":["cs.SE", "cs.PL", "cs.CY"],
    "Aerospace Engineering":["physics.flu-dyn", "cs.RO", "eess.SP"],
    "Electrical Engineering":["eess.SP", "eess.SY", "cs.ET"],
    "Chemical Engineering": ["physics.chem-ph", "cond-mat.soft"],
}


def fetch_arxiv(category_key: str, target: int, label: str) -> list[dict]:
    docs: list[dict] = []
    subjects = _ARXIV_SUBJECTS.get(category_key, [])
    if not subjects:
        return docs

    batch = 100
    for subject in subjects:
        if len(docs) >= target:
            break
        start = 0
        while len(docs) < target:
            want = min(batch, target - len(docs))
            url = (
                f"{_ARXIV_ATOM}?search_query=cat:{subject}"
                f"&start={start}&max_results={want}"
                f"&sortBy=submittedDate&sortOrder=descending"
            )
            print(f"    arXiv {subject} start={start} want={want} …", end=" ", flush=True)
            rate_sleep()
            raw = fetch_url(url)
            if not raw:
                break
            try:
                root = ET.fromstring(raw)
            except ET.ParseError:
                break

            entries = root.findall("a:entry", _ARXIV_NS)
            if not entries:
                break

            added = 0
            for entry in entries:
                ab_el = entry.find("a:summary", _ARXIV_NS)
                ti_el = entry.find("a:title",   _ARXIV_NS)
                if ab_el is None or not ab_el.text:
                    continue
                title    = clean_text(ti_el.text if ti_el is not None else "")
                abstract = clean_text(ab_el.text)
                content  = (title + ". " + abstract) if title else abstract
                fname    = generate_filename(label)
                d = make_doc(content, label, "arxiv", fname)
                if d:
                    docs.append(d)
                    added += 1
                if len(docs) >= target:
                    break
            print(f"got {added} (total {len(docs)})")
            start += len(entries)
            if len(entries) < want:
                break

    return docs[:target]


# ── Fetcher: PubMed ───────────────────────────────────────────────────────

_PUBMED_SEARCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi"
_PUBMED_FETCH  = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi"

_PUBMED_QUERIES_BY_CAT: dict[str, list[str]] = {
    "Science": [
        "cell biology[MeSH Major Topic]", "organic chemistry[MeSH Major Topic]",
        "particle physics", "ecology evolution[MeSH Major Topic]",
        "molecular biology genetics[MeSH Major Topic]", "neuroscience[MeSH Major Topic]",
        "biochemistry[MeSH Major Topic]", "astrophysics astronomy",
        "immunology[MeSH Major Topic]", "materials science",
    ],
    "Biology": [
        "cell biology genetics", "evolutionary biology", "microbiology[MeSH Major Topic]",
        "ecology biodiversity", "molecular biology[MeSH Major Topic]",
        "neuroscience brain", "developmental biology", "immunology infection",
        "plant biology botany", "marine biology oceanography",
    ],
    "Chemistry": [
        "organic synthesis chemistry", "analytical chemistry spectroscopy",
        "physical chemistry thermodynamics", "biochemistry enzyme catalysis",
        "inorganic chemistry coordination", "polymer chemistry materials",
        "computational chemistry molecular simulation",
    ],
    "Physics": [
        "quantum mechanics wave function", "condensed matter physics",
        "particle physics standard model", "astrophysics cosmology",
        "thermodynamics statistical mechanics", "optics photonics laser",
        "nuclear physics radiation", "plasma physics",
    ],
    "Clinical Research": [
        "randomized controlled trial[Publication Type]", "clinical trial phase III",
        "cohort study outcomes", "systematic review meta-analysis clinical",
        "observational study epidemiology", "clinical pharmacology drug efficacy",
    ],
    "Medical Education": [
        "medical education curriculum", "clinical training residency",
        "medical student learning outcomes", "simulation medical training",
        "pathology medical education", "pharmacology teaching",
    ],
    "Mental Health/Therapy": [
        "depression anxiety treatment[MeSH Major Topic]", "cognitive behavioral therapy",
        "psychotherapy outcomes", "mental health intervention",
        "psychiatry schizophrenia bipolar", "mindfulness stress reduction",
    ],
    "Pediatrics": [
        "pediatric medicine child health", "neonatal intensive care",
        "childhood development growth", "pediatric oncology",
        "vaccination immunization children", "adolescent health",
    ],
    "Nutrition/Diet": [
        "nutrition diet obesity", "dietary patterns chronic disease",
        "micronutrients vitamins minerals", "gut microbiome diet",
        "sports nutrition athlete performance",
    ],
    "Public Health": [
        "public health epidemiology", "infectious disease outbreak",
        "health disparities social determinants", "vaccination public health",
        "chronic disease prevention", "environmental health exposure",
    ],
    "Surgical Procedures": [
        "surgical technique operative", "minimally invasive surgery laparoscopic",
        "orthopedic surgery outcomes", "cardiac surgery procedure",
        "surgical complications postoperative", "robotic surgery",
    ],
    "Radiology/Imaging": [
        "radiology imaging diagnosis", "MRI findings interpretation",
        "CT scan diagnostic radiology", "ultrasound imaging",
        "nuclear medicine PET scan", "interventional radiology",
    ],
}

_AB_RE = re.compile(r"AB\s+-\s+(.+?)(?=\n[A-Z]{2,4}\s+-|\Z)", re.DOTALL)
_TI_RE = re.compile(r"TI\s+-\s+(.+?)(?=\n[A-Z]{2,4}\s+-|\Z)", re.DOTALL)


def fetch_pubmed_category(category: str, target: int, queries: list[str]) -> list[dict]:
    docs: list[dict] = []
    per_q = max(20, (target // len(queries)) + 10)

    for query in queries:
        if len(docs) >= target:
            break
        print(f"    PubMed [{category}]: {query[:50]} …", end=" ", flush=True)
        search_url = (
            f"{_PUBMED_SEARCH}?db=pubmed&term={quote_plus(query)}"
            f"&retmax={per_q}&retmode=json&sort=date"
        )
        rate_sleep()
        result = fetch_json(search_url)
        if not result:
            print("search failed")
            continue
        ids = result.get("esearchresult", {}).get("idlist", [])
        if not ids:
            print("0 IDs")
            continue

        batch_size = 20
        added = 0
        for i in range(0, len(ids), batch_size):
            if len(docs) >= target:
                break
            id_str    = ",".join(ids[i: i + batch_size])
            fetch_str = (
                f"{_PUBMED_FETCH}?db=pubmed&id={id_str}"
                f"&rettype=abstract&retmode=text"
            )
            rate_sleep()
            raw = fetch_url(fetch_str)
            if not raw:
                continue
            text    = raw.decode("utf-8", errors="replace")
            records = re.split(r"\n\s*\n\s*\n", text)
            for record in records:
                if len(docs) >= target:
                    break
                ab_m = _AB_RE.search(record)
                if not ab_m:
                    continue
                ti_m    = _TI_RE.search(record)
                title   = clean_text(ti_m.group(1)) if ti_m else ""
                abstract = clean_text(ab_m.group(1))
                content = (title + ". " + abstract) if title else abstract
                fname   = generate_filename(category)
                d = make_doc(content, category, "pubmed", fname)
                if d:
                    docs.append(d)
                    added += 1
        print(f"got {added} (total {len(docs)})")

    return docs[:target]


# ── Fetcher: Wikipedia ────────────────────────────────────────────────────

_WP_SEARCH  = "https://en.wikipedia.org/w/api.php"
_WP_SUMMARY = "https://en.wikipedia.org/api/rest_v1/page/summary/{title}"

_WIKI_TERMS: dict[str, list[str]] = {
    "History": [
        "World War II battles Europe", "American Revolution founding fathers",
        "Ancient Rome Republic Empire", "French Revolution Napoleonic era",
        "Cold War nuclear arms race", "Renaissance humanism Florence",
        "Medieval feudalism crusades", "Ottoman Empire history",
        "American Civil War slavery", "Industrial Revolution factory system",
        "World War I trenches armistice", "Ancient Greece democracy",
        "British Empire colonialism", "Russian Revolution 1917",
        "Chinese history dynasties", "African colonialism independence",
        "Japanese Meiji Restoration", "Indian independence Gandhi",
        "Egyptian ancient Pharaohs", "Byzantine Empire Constantinople",
        "Mongol Empire Genghis Khan", "Spanish Conquest Americas",
    ],
    "Political Science": [
        "democracy government systems comparative politics",
        "political theory liberalism conservatism",
        "international relations foreign policy",
        "electoral systems voting behavior",
        "federalism separation of powers",
        "political ideology socialism capitalism",
        "geopolitics nation state sovereignty",
        "United Nations international organizations",
        "constitutional law civil liberties",
        "political parties parliamentary systems",
    ],
    "Economics": [
        "macroeconomics GDP inflation monetary policy",
        "microeconomics supply demand market equilibrium",
        "behavioral economics consumer decision making",
        "international trade comparative advantage",
        "economic inequality income distribution",
        "Keynesian economics fiscal stimulus",
        "free market capitalism economic theory",
        "development economics poverty growth",
        "game theory Nash equilibrium",
        "labor economics employment wages",
    ],
    "Geography": [
        "physical geography landforms erosion",
        "human geography urbanization migration",
        "climate zones biomes geography",
        "geopolitics borders territories",
        "cartography map projections",
        "population density distribution",
        "natural resources geographical distribution",
        "river systems drainage basins",
        "tectonic plates earthquakes volcanoes",
        "cultural geography ethnicity language",
    ],
    "Philosophy": [
        "Western philosophy Plato Aristotle",
        "ethics moral philosophy deontology utilitarianism",
        "epistemology theory of knowledge",
        "metaphysics ontology existence",
        "logic argument validity soundness",
        "political philosophy Locke Rousseau",
        "philosophy of mind consciousness",
        "existentialism Sartre Camus",
        "philosophy of science empiricism",
        "Eastern philosophy Buddhism Confucianism",
    ],
    "Psychology": [
        "cognitive psychology memory perception",
        "developmental psychology Piaget stages",
        "social psychology group behavior conformity",
        "clinical psychology mental disorders DSM",
        "personality psychology traits theories",
        "behavioral psychology conditioning reinforcement",
        "neuroscience brain behavior",
        "positive psychology well-being resilience",
        "forensic psychology criminal behavior",
        "psychoanalysis Freud unconscious mind",
    ],
    "Sociology": [
        "sociology social stratification class",
        "cultural sociology norms values institutions",
        "race ethnicity inequality society",
        "gender sociology feminism",
        "urbanization cities community",
        "crime deviance social control",
        "religion sociology Durkheim Weber",
        "family marriage social institutions",
        "globalization social change",
        "education sociology socialization",
    ],
    "Religious Studies": [
        "Christianity theology Bible history",
        "Islam Quran Muhammad history",
        "Judaism Torah history",
        "Buddhism dharma meditation history",
        "Hinduism sacred texts philosophy",
        "Comparative religion ritual practice",
        "Reformation Protestant Catholic history",
        "mysticism spirituality religious experience",
        "religion and science philosophy",
        "ethics morality religion theology",
    ],
    "Environmental Science": [
        "climate change greenhouse gas emissions",
        "biodiversity conservation endangered species",
        "pollution air water soil environmental",
        "renewable energy solar wind power",
        "deforestation land use change",
        "ocean acidification marine ecosystem",
        "sustainability environmental policy",
        "ecosystem services natural capital",
        "environmental toxicology contamination",
        "freshwater scarcity water resources",
    ],
    "Public Health": [
        "epidemiology disease outbreak surveillance",
        "global health infectious disease WHO",
        "vaccination immunization public health",
        "chronic disease prevention cardiovascular",
        "mental health public health policy",
        "health equity social determinants",
        "environmental health exposure pollution",
        "pandemic influenza COVID public health",
        "maternal child health nutrition",
        "substance abuse addiction public health",
    ],
    "Intellectual Property": [
        "patent law intellectual property",
        "copyright fair use trademark",
        "trade secret confidential information",
        "software patent digital rights",
        "creative commons licensing",
        "DMCA copyright infringement",
        "pharmaceutical patent drug exclusivity",
        "trademark registration brand protection",
    ],
    "Corporate Law": [
        "corporate governance board directors",
        "securities regulation SEC compliance",
        "mergers acquisitions due diligence",
        "corporate liability shareholder rights",
        "antitrust competition law",
        "business entity formation corporation LLC",
        "securities fraud insider trading",
    ],
    "Criminal Law": [
        "criminal procedure due process",
        "Fourth Amendment search seizure",
        "criminal sentencing guidelines",
        "murder homicide criminal law",
        "white collar crime fraud",
        "criminal defense constitutional rights",
        "plea bargain criminal justice",
        "drug offenses criminal prosecution",
    ],
    "Immigration Law": [
        "immigration visa green card",
        "asylum refugee immigration law",
        "citizenship naturalization process",
        "immigration enforcement deportation",
        "DACA dreamers immigration policy",
        "work visa H1B employment immigration",
    ],
    "Employment Law": [
        "labor law employment discrimination",
        "workplace safety OSHA regulations",
        "wrongful termination employment at will",
        "FLSA minimum wage overtime",
        "workers compensation injury",
        "collective bargaining union labor",
        "sexual harassment workplace law",
        "ADA disability employment accommodation",
    ],
    "Family Law": [
        "divorce dissolution marriage law",
        "child custody visitation rights",
        "child support calculation guidelines",
        "adoption foster care legal process",
        "domestic violence restraining order",
        "alimony spousal support",
        "prenuptial agreement marriage law",
    ],
    "Mechanical Engineering": [
        "mechanical engineering design thermodynamics",
        "fluid mechanics engineering",
        "manufacturing processes machining",
        "materials science engineering metals",
        "robotics automation mechanical systems",
        "heat transfer thermal engineering",
        "machine design stress analysis",
        "HVAC mechanical systems building",
    ],
    "Civil Engineering": [
        "structural engineering bridge design",
        "geotechnical engineering soil foundation",
        "transportation engineering highway design",
        "water resources hydraulic engineering",
        "construction management project planning",
        "urban planning infrastructure development",
        "environmental civil engineering",
    ],
    "Electrical Engineering": [
        "electrical engineering circuit design",
        "power systems electrical grid",
        "signal processing digital communications",
        "microelectronics semiconductor device",
        "control systems automation",
        "renewable energy electrical systems",
        "telecommunications network engineering",
    ],
    "Chemical Engineering": [
        "chemical process engineering reactor design",
        "mass transfer separation processes",
        "chemical plant safety process control",
        "polymer engineering plastics materials",
        "petroleum refining chemical engineering",
        "bioprocess engineering fermentation",
    ],
    "Aerospace Engineering": [
        "aerodynamics aircraft flight mechanics",
        "rocket propulsion spacecraft design",
        "avionics navigation systems",
        "structural aerospace composite materials",
        "satellite orbit mechanics",
        "supersonic hypersonic flight",
    ],
    "Industrial Engineering": [
        "operations research optimization",
        "lean manufacturing six sigma",
        "supply chain logistics engineering",
        "ergonomics human factors",
        "quality management systems ISO",
        "production planning scheduling",
    ],
    "Business Strategy": [
        "corporate strategy competitive advantage Porter",
        "strategic management business model",
        "Blue Ocean strategy innovation",
        "mergers acquisitions business strategy",
        "digital transformation business",
        "balanced scorecard strategic planning",
        "BCG matrix portfolio analysis",
    ],
    "Marketing/Advertising": [
        "digital marketing strategy social media",
        "brand marketing consumer behavior",
        "advertising campaign creative strategy",
        "content marketing SEO inbound",
        "market segmentation targeting positioning",
        "marketing analytics data driven",
        "influencer marketing social media brand",
    ],
    "Human Resources": [
        "human resources management talent acquisition",
        "employee performance management",
        "organizational culture HR strategy",
        "compensation benefits HR policy",
        "diversity inclusion workplace",
        "HR compliance labor law",
        "employee training development HR",
    ],
    "Project Management": [
        "project management methodology Agile Scrum",
        "project planning risk management",
        "PMP certification project management",
        "Waterfall project development lifecycle",
        "stakeholder management communication",
        "project scope schedule budget triangle",
        "Kanban workflow project management",
    ],
    "Entrepreneurship": [
        "startup entrepreneurship venture capital",
        "lean startup methodology MVP",
        "entrepreneurship innovation business model",
        "small business startup failure success",
        "angel investor funding startup",
        "entrepreneurship ecosystem Silicon Valley",
    ],
    "Government Regulations": [
        "federal regulations administrative law",
        "regulatory agency FDA EPA rules",
        "financial regulation banking Dodd-Frank",
        "environmental regulation Clean Air Act",
        "data privacy regulation GDPR CCPA",
        "healthcare regulation CMS Medicare",
    ],
    "Policy Documents": [
        "public policy analysis government",
        "economic policy fiscal monetary",
        "social policy welfare education",
        "foreign policy national security strategy",
        "healthcare policy reform insurance",
        "education policy school reform",
        "environmental policy climate legislation",
    ],
    "Military/Defense": [
        "military history warfare strategy",
        "national security defense policy",
        "military technology weapons systems",
        "NATO alliance defense cooperation",
        "counterterrorism intelligence operations",
        "military ethics laws of war",
        "nuclear deterrence arms control",
    ],
    "Legislative Bills": [
        "congressional bill legislation",
        "statutory law legislative history",
        "bill amendment Congress Senate House",
        "state legislature law enactment",
        "regulatory legislation agency rulemaking",
        "civil rights legislation historical",
    ],
    "Census/Statistics": [
        "US Census Bureau demographic data",
        "population statistics demographics",
        "labor statistics employment unemployment",
        "economic statistics GDP income",
        "health statistics mortality morbidity",
        "education statistics enrollment graduation",
    ],
    "Journalism": [
        "investigative journalism reporting",
        "news article political reporting",
        "feature journalism narrative writing",
        "press freedom journalism ethics",
        "data journalism visualization",
        "war journalism foreign correspondent",
    ],
    "Cryptocurrency": [
        "Bitcoin blockchain cryptocurrency",
        "Ethereum smart contracts DeFi",
        "cryptocurrency regulation SEC",
        "NFT non-fungible token digital art",
        "crypto mining proof of work",
        "stablecoin central bank digital currency",
    ],
    "Stock Market": [
        "stock market investing equities",
        "value investing Warren Buffett",
        "technical analysis chart patterns trading",
        "IPO initial public offering",
        "stock market crash correction",
        "index funds ETF passive investing",
        "options futures derivatives trading",
    ],
    "Real Estate Investment": [
        "real estate investment REIT",
        "rental property cash flow investment",
        "commercial real estate investment",
        "house flipping real estate",
        "real estate market analysis",
        "property tax depreciation investment",
    ],
    "Personal Finance": [
        "personal finance budgeting saving",
        "debt management credit card payoff",
        "emergency fund financial planning",
        "home buying first time mortgage",
        "student loan repayment strategy",
        "financial independence early retirement FIRE",
    ],
    "Retirement Planning": [
        "retirement planning 401k IRA savings",
        "Social Security retirement benefits",
        "pension fund retirement income",
        "retirement age financial planning",
        "Roth IRA traditional IRA comparison",
        "retirement withdrawal strategy",
    ],
    "Insurance": [
        "health insurance coverage plans",
        "life insurance term whole universal",
        "auto insurance coverage liability",
        "homeowners insurance property coverage",
        "disability insurance income protection",
        "business liability insurance commercial",
    ],
    "Mortgage/Loans": [
        "mortgage home loan interest rate",
        "refinancing mortgage rate comparison",
        "student loan debt repayment",
        "personal loan credit score",
        "FHA VA conventional mortgage",
        "home equity loan HELOC",
    ],
    "Accounting": [
        "accounting financial statements GAAP",
        "corporate accounting audit balance sheet",
        "tax accounting deductions credits",
        "managerial accounting cost analysis",
        "forensic accounting fraud detection",
        "IFRS international accounting standards",
    ],
    "Network Administration": [
        "computer networking TCP IP protocols",
        "network security firewall VPN",
        "router switch network configuration",
        "DNS DHCP network services",
        "software defined networking SDN",
        "network monitoring troubleshooting",
    ],
    "Cybersecurity": [
        "cybersecurity threats malware ransomware",
        "information security penetration testing",
        "NIST cybersecurity framework",
        "data breach incident response",
        "zero trust security architecture",
        "encryption cryptography security",
        "social engineering phishing attacks",
    ],
    "Cloud Infrastructure": [
        "cloud computing AWS Azure Google Cloud",
        "cloud architecture microservices",
        "DevOps cloud deployment CI CD",
        "cloud security compliance",
        "serverless computing functions",
        "cloud cost optimization FinOps",
    ],
    "Data Science": [
        "machine learning data science Python",
        "deep learning neural networks",
        "natural language processing NLP",
        "data visualization analysis",
        "statistical learning predictive modeling",
        "big data analytics Spark Hadoop",
        "computer vision image recognition",
    ],
    "Research Papers": [
        "academic research methodology paper",
        "peer reviewed journal article",
        "scientific paper publication",
        "research findings conclusions",
        "interdisciplinary research study",
    ],
    "Grant Proposals": [
        "research grant funding NIH NSF",
        "grant proposal research objectives",
        "scientific funding application",
        "federal research grant program",
    ],
    "Literature Review": [
        "literature review systematic review",
        "academic literature survey",
        "meta-analysis research synthesis",
        "state of the art research overview",
    ],
    "Conference Papers": [
        "conference proceedings academic paper",
        "NeurIPS ICML conference machine learning",
        "academic conference presentation abstract",
        "peer reviewed conference paper",
    ],
    "Travel Plans": [
        "travel itinerary vacation planning",
        "European trip backpacking travel",
        "travel guide destination guide",
        "international travel tips advice",
    ],
    "Recipes/Cooking": [
        "recipe cooking food preparation",
        "Italian cooking pasta recipes",
        "baking bread dessert recipe",
        "meal prep healthy cooking",
        "Asian cuisine cooking techniques",
    ],
}

_BIO_DESCRIPTION_KEYWORDS = [
    "born", "author", "politician", "athlete", "musician", "actor",
    "director", "writer", "scientist", "philosopher", "artist",
    "activist", "entrepreneur", "historian", "journalist",
]

_GUTENBERG_TOPICS = [
    "?topic=fiction&languages=en&mime_type=text%2F",
    "?topic=short+stories&languages=en&mime_type=text%2F",
    "?topic=essays&languages=en&mime_type=text%2F",
    "?topic=poetry&languages=en&mime_type=text%2F",
    "?topic=drama&languages=en&mime_type=text%2F",
    "?topic=novel&languages=en&mime_type=text%2F",
    "?topic=romance&languages=en&mime_type=text%2F",
]

_GUTENBERG_LETTERS_TOPICS = [
    "?topic=letters&languages=en&mime_type=text%2F",
    "?topic=autobiography&languages=en&mime_type=text%2F",
    "?topic=diaries&languages=en&mime_type=text%2F",
    "?topic=biography&languages=en&mime_type=text%2F",
]

_GUTENBERG_ROUTING: dict[str, list[str]] = {
    "English/Literature": _GUTENBERG_TOPICS,
    "Creative Writing":   _GUTENBERG_TOPICS,
    "Personal Letters":   _GUTENBERG_LETTERS_TOPICS,
}


def fetch_wikipedia_category(
    search_terms: list[str],
    label: str,
    target: int,
    source: str = "wikipedia",
    description_filter: list[str] | None = None,
) -> list[dict]:
    docs: list[dict] = []
    for term in search_terms:
        if len(docs) >= target:
            break
        print(f"    Wikipedia [{label}]: {term[:50]} …", end=" ", flush=True)
        added = 0
        url = (
            f"{_WP_SEARCH}?action=query&list=search"
            f"&srsearch={quote_plus(term)}&srlimit=20"
            f"&format=json&utf8=1"
        )
        rate_sleep()
        result = fetch_json(url)
        if not result:
            print("failed")
            continue

        for hit in result.get("query", {}).get("search", []):
            if len(docs) >= target:
                break
            title = hit.get("title", "")
            if not title:
                continue
            rate_sleep()
            summary = fetch_json(_WP_SUMMARY.format(title=quote_plus(title)))
            if not summary:
                continue
            if description_filter:
                desc = (summary.get("description") or "").lower()
                if not any(kw in desc for kw in description_filter):
                    continue
            extract = summary.get("extract", "")
            fname   = generate_filename(label)
            d = make_doc(extract, label, source, fname)
            if d:
                docs.append(d)
                added += 1
        print(f"got {added} (total {len(docs)})")

    return docs[:target]


# ── Fetcher: Project Gutenberg ────────────────────────────────────────────

_GUTENDEX = "https://gutendex.com/books/"


def _gutenberg_excerpt(text_url: str, word_offset: int = 500) -> str | None:
    rate_sleep()
    data = fetch_url(text_url)
    if not data:
        return None
    try:
        text = data.decode("utf-8", errors="replace")
    except Exception:
        return None
    m = re.search(r"\*\*\* START OF[^\n]+\n", text, re.IGNORECASE)
    if m:
        text = text[m.end():]
    words = text.split()
    if len(words) < word_offset + 60:
        return None
    excerpt = " ".join(words[word_offset: word_offset + MAX_WORDS])
    return clean_text(excerpt) or None


def fetch_gutenberg(target: int, category: str, topics: list[str]) -> list[dict]:
    docs: list[dict] = []
    seen_ids: set[int] = set()

    for topic_qs in topics:
        if len(docs) >= target:
            break
        url  = _GUTENDEX + topic_qs
        page = 1

        while len(docs) < target:
            page_url = url + (f"&page={page}" if page > 1 else "")
            print(f"    Gutenberg {topic_qs[:30]} page={page} …", end=" ", flush=True)
            rate_sleep()
            result = fetch_json(page_url)
            if not result:
                break
            books = result.get("results", [])
            if not books:
                break

            added = 0
            for book in books:
                if len(docs) >= target:
                    break
                bid = book.get("id")
                if bid in seen_ids:
                    continue
                seen_ids.add(bid)
                formats  = book.get("formats", {})
                text_url = (
                    formats.get("text/plain; charset=utf-8")
                    or formats.get("text/plain; charset=us-ascii")
                    or formats.get("text/plain")
                )
                if not text_url:
                    continue
                excerpt = _gutenberg_excerpt(text_url)
                if not excerpt:
                    continue
                title   = book.get("title", "")
                authors = book.get("authors", [])
                author  = authors[0].get("name", "") if authors else ""
                prefix  = f"[From: {title}" + (f" by {author}" if author else "") + "] "
                content = truncate_words(prefix + excerpt)
                fname   = generate_filename(category)
                d = make_doc(content, category, "gutenberg", fname)
                if d:
                    docs.append(d)
                    added += 1
            print(f"got {added} (total {len(docs)})")
            if not result.get("next"):
                break
            page += 1

    return docs[:target]


# ── Fetcher: Semantic Scholar ─────────────────────────────────────────────

_SS_SEARCH = "https://api.semanticscholar.org/graph/v1/paper/search"

_SS_QUERIES_BY_CAT: dict[str, list[str]] = {
    "AP Seminar/Academic Research": [
        "research methodology qualitative quantitative analysis",
        "interdisciplinary academic discourse semiotics",
        "literature review systematic review meta-analysis",
        "critical analysis cultural studies anthropology",
        "political science international relations theory",
        "environmental policy sustainability governance",
        "cognitive psychology behavioral science",
        "economics policy welfare inequality",
        "communication rhetoric argumentation",
        "media studies journalism framing",
        "philosophy ethics moral reasoning",
        "education pedagogy curriculum",
    ],
    "Research Papers": [
        "experimental research scientific methodology",
        "empirical study data collection analysis",
        "theoretical framework academic research",
        "peer reviewed research publication",
        "interdisciplinary research innovation",
    ],
    "Literature Review": [
        "systematic literature review meta-analysis",
        "narrative review research synthesis",
        "scoping review evidence mapping",
        "state of the art survey overview",
    ],
    "Grant Proposals": [
        "research funding NIH grant application",
        "NSF research proposal methodology",
        "biomedical research grant objectives",
        "social science research funding",
    ],
    "Conference Papers": [
        "computer science conference NeurIPS ICML",
        "academic conference proceedings",
        "workshop paper machine learning",
        "symposium research presentation",
    ],
    "Lab Reports": [
        "experimental laboratory methods results",
        "scientific experiment data analysis",
        "laboratory findings methodology",
        "research experiment protocol",
    ],
    "Data Science": [
        "machine learning deep learning classification",
        "natural language processing text mining",
        "data analysis statistical modeling",
        "computer vision image recognition deep learning",
        "reinforcement learning optimization",
    ],
}


def fetch_semantic_scholar_category(category: str, target: int, queries: list[str]) -> list[dict]:
    docs: list[dict] = []
    per_q = min(100, max(25, (target // len(queries)) + 10))

    for query in queries:
        if len(docs) >= target:
            break
        print(f"    SemanticScholar [{category}]: {query[:50]} …", end=" ", flush=True)
        url = (
            f"{_SS_SEARCH}?query={quote_plus(query)}"
            f"&fields=title,abstract&limit={per_q}"
        )
        rate_sleep()
        result = fetch_json(url)
        if not result:
            print("failed")
            continue

        added = 0
        for paper in result.get("data", []):
            if len(docs) >= target:
                break
            abstract = paper.get("abstract") or ""
            title    = paper.get("title") or ""
            if not abstract or len(abstract.split()) < 30:
                continue
            content = (clean_text(title) + ". " + clean_text(abstract)) if title else clean_text(abstract)
            fname   = generate_filename(category)
            d = make_doc(content, category, "semantic_scholar", fname)
            if d:
                docs.append(d)
                added += 1
        print(f"got {added} (total {len(docs)})")

    return docs[:target]


# ── Fetcher: SEC EDGAR ────────────────────────────────────────────────────

_EDGAR_SEARCH = "https://efts.sec.gov/LATEST/search-index"

_EDGAR_QUERIES_BY_CAT: dict[str, list[str]] = {
    "Business Strategy": [
        "business strategy competitive advantage market position",
        "corporate strategy growth acquisition",
        "digital transformation technology investment",
        "strategic initiative business development",
    ],
    "Corporate Finance": [
        "revenue growth operating income margins",
        "capital expenditures investments liquidity",
        "net income earnings shareholders equity",
        "financial performance quarterly results",
    ],
    "Accounting": [
        "management discussion analysis results operations",
        "financial statements audited accounts",
        "revenue recognition accounting policy",
        "internal controls financial reporting",
    ],
    "Stock Market": [
        "stock repurchase shareholder value",
        "dividend policy earnings per share",
        "equity compensation stock options",
        "securities offering prospectus",
    ],
    "Entrepreneurship": [
        "startup company growth strategy emerging business",
        "venture capital backed company growth",
        "business development new market entry",
    ],
}

_EDGAR_DEFAULT_QUERIES = [
    "revenue growth operating income margins",
    "risk factors competition regulatory",
    "business overview strategy acquisitions",
    "management discussion analysis results",
    "capital expenditures investments liquidity",
    "supply chain operations manufacturing",
    "net income earnings shareholders",
    "products services market customers",
    "digital transformation technology investment",
    "environmental social governance ESG",
]


def fetch_sec_edgar_category(category: str, target: int) -> list[dict]:
    docs: list[dict] = []
    queries = _EDGAR_QUERIES_BY_CAT.get(category, _EDGAR_DEFAULT_QUERIES)

    for query in queries:
        if len(docs) >= target:
            break
        print(f"    SEC EDGAR [{category}]: {query[:50]} …", end=" ", flush=True)
        params = {
            "q": query, "forms": "10-K",
            "dateRange": "custom", "startdt": "2021-01-01", "enddt": "2024-06-01",
        }
        url = f"{_EDGAR_SEARCH}?{urlencode(params)}"
        rate_sleep()
        result = fetch_json(url)
        if not result:
            print("failed")
            continue

        hits  = result.get("hits", {}).get("hits", [])
        added = 0
        for hit in hits:
            if len(docs) >= target:
                break
            src       = hit.get("_source", {})
            highlight = hit.get("highlight", {})
            pieces: list[str] = []
            for field_snips in highlight.values():
                for snip in field_snips:
                    pieces.append(re.sub(r"</?em>", "", snip))
            entity = src.get("entity_name", "")
            period = src.get("period_of_report", "")
            form   = src.get("form_type", "10-K")
            if entity:
                pieces.insert(0, f"{entity} {form} for period {period}.")
            content = " ".join(pieces)
            fname   = generate_filename(category)
            d = make_doc(content, category, "sec_edgar", fname)
            if d:
                docs.append(d)
                added += 1
        print(f"got {added} (total {len(docs)})")

    return docs[:target]


# ── Fetcher: CourtListener ────────────────────────────────────────────────

_CL_OPINIONS = "https://www.courtlistener.com/api/rest/v3/opinions/"

_LEGAL_WIKI_TERMS: dict[str, list[str]] = {
    "Contracts":           ["contract law breach consideration", "contract formation offer acceptance", "UCC contract commercial law"],
    "Court Documents":     ["United States Supreme Court landmark case", "federal court judicial opinion", "appellate court ruling"],
    "Legal Research":      ["legal precedent common law doctrine", "statutory interpretation judicial", "legal standard burden of proof"],
    "Real Estate Law":     ["real estate property law deed", "landlord tenant property rights", "real property title transfer"],
    "Corporate Law":       ["corporate law shareholder derivative", "SEC securities regulation", "corporate governance fiduciary duty"],
    "Criminal Law":        ["criminal law due process Fourth Amendment", "criminal sentencing guidelines", "Fifth Amendment Miranda rights"],
    "Immigration Law":     ["immigration law visa asylum", "immigration court deportation", "USCIS immigration policy"],
    "Intellectual Property":["intellectual property copyright trademark", "patent infringement trade secret", "DMCA copyright law"],
    "Wills/Trusts/Estate": ["estate law probate wills trusts", "estate planning inheritance", "testamentary trust fiduciary"],
    "Employment Law":      ["employment discrimination Title VII", "FLSA labor law wage hour", "NLRA collective bargaining union"],
    "Family Law":          ["family law divorce custody", "child support family court", "domestic relations law"],
    "Regulatory Compliance":["administrative law regulatory compliance", "FDA regulation pharmaceutical", "EPA environmental compliance"],
}


def fetch_court_listener_category(category: str, target: int) -> list[dict]:
    docs: list[dict] = []
    page     = 1
    max_pages = 25

    while len(docs) < target and page <= max_pages:
        url = f"{_CL_OPINIONS}?format=json&page_size=20&order_by=-date_created&page={page}"
        print(f"    CourtListener [{category}] page={page} …", end=" ", flush=True)
        rate_sleep()
        result = fetch_json(url)
        if not result:
            print("failed")
            break
        opinions = result.get("results", [])
        if not opinions:
            break

        added = 0
        for op in opinions:
            if len(docs) >= target:
                break
            raw = op.get("plain_text") or ""
            if not raw:
                html = op.get("html_with_citations") or op.get("html") or ""
                raw  = html
            if not raw or len(raw.split()) < 30:
                continue
            content = clean_text(raw)
            fname   = generate_filename(category)
            d = make_doc(content, category, "court_listener", fname)
            if d:
                docs.append(d)
                added += 1
        print(f"got {added} (total {len(docs)})")
        page += 1

    # Fill with Wikipedia legal terms
    if len(docs) < target:
        wiki_terms = _LEGAL_WIKI_TERMS.get(category, ["legal law court case"])
        shortage   = target - len(docs)
        extra = fetch_wikipedia_category(
            wiki_terms, category, shortage, source="wikipedia_legal"
        )
        docs.extend(extra)

    return docs[:target]


# ── Category Dispatcher ────────────────────────────────────────────────────

def fetch_for_category(category: str, target: int) -> list[dict]:
    """
    Route to the best available source(s) for a category, then fill remainder
    with Wikipedia and/or Ollama synthetic generation.
    """
    docs: list[dict] = []

    # Compute real-API target (leave SYNTHETIC_RATIO for synthetic fill)
    api_target = int(target * (1.0 - SYNTHETIC_RATIO))

    # ── arXiv ──────────────────────────────────────────────────────────────
    if category in _ARXIV_SUBJECTS:
        docs.extend(fetch_arxiv(category, api_target, category))

    # ── PubMed ─────────────────────────────────────────────────────────────
    elif category in _PUBMED_QUERIES_BY_CAT:
        docs.extend(fetch_pubmed_category(
            category, api_target, _PUBMED_QUERIES_BY_CAT[category]
        ))

    # ── Gutenberg ──────────────────────────────────────────────────────────
    elif category in _GUTENBERG_ROUTING:
        docs.extend(fetch_gutenberg(api_target, category, _GUTENBERG_ROUTING[category]))

    # ── Semantic Scholar ───────────────────────────────────────────────────
    elif category in _SS_QUERIES_BY_CAT:
        docs.extend(fetch_semantic_scholar_category(
            category, api_target, _SS_QUERIES_BY_CAT[category]
        ))

    # ── SEC EDGAR ──────────────────────────────────────────────────────────
    elif category in (*_EDGAR_QUERIES_BY_CAT.keys(), "Business", "Supply Chain", "Operations Management"):
        docs.extend(fetch_sec_edgar_category(category, api_target))

    # ── CourtListener (all Legal sub-categories) ───────────────────────────
    elif category in _LEGAL_WIKI_TERMS or category in ("Contracts", "Court Documents",
            "Legal Research", "Real Estate Law", "Corporate Law", "Criminal Law",
            "Immigration Law", "Intellectual Property", "Wills/Trusts/Estate",
            "Employment Law", "Family Law", "Regulatory Compliance"):
        docs.extend(fetch_court_listener_category(category, api_target))

    # ── Wikipedia fill ─────────────────────────────────────────────────────
    if len(docs) < target and category in _WIKI_TERMS:
        wiki_target = min(target - len(docs), int(target * 0.60))
        docs.extend(
            fetch_wikipedia_category(
                _WIKI_TERMS[category], category, wiki_target
            )
        )

    # ── Wikipedia biography (Personal/Other legacy) ────────────────────────
    if category == "Personal Letters" and len(docs) < target:
        bio_terms = [
            "autobiography memoir personal narrative",
            "famous athlete biography career",
            "musician artist personal life biography",
            "politician leader public figure biography",
        ]
        docs.extend(
            fetch_wikipedia_category(
                bio_terms, category, target - len(docs),
                source="wikipedia_biography",
                description_filter=_BIO_DESCRIPTION_KEYWORDS,
            )
        )

    # ── Synthetic fill ─────────────────────────────────────────────────────
    if len(docs) < target:
        remaining = target - len(docs)
        docs.extend(generate_synthetic_examples(category, remaining))

    return docs[:target]


# ── Finetune Formatter ────────────────────────────────────────────────────

def make_finetune_example(doc: dict) -> dict:
    """
    Convert a raw document dict to Unsloth conversations format.
    Includes filename in the user message. 6–8 folders in distractor list.
    """
    category = doc["category"]
    content  = doc["content"]
    filename = doc.get("filename", "")

    others    = [c for c in ALL_CATEGORIES if c != category]
    n_others  = random.randint(5, 7)
    selected  = random.sample(others, min(n_others, len(others)))
    folders   = selected + [category]
    random.shuffle(folders)

    folders_str = "\n".join(f"- {f}" for f in folders)

    if filename:
        file_line = f"File name: {filename}\n"
    else:
        file_line = ""

    user_message = (
        f"{file_line}"
        f"File content:\n{content}\n\n"
        f"Available folders:\n{folders_str}\n\n"
        f"Which folder does this file belong in?"
    )

    reasoning         = REASONING.get(category, f"This document belongs in the {category} folder.")
    assistant_response = f"{category} | {reasoning}"

    return {
        "conversations": [
            {"role": "system",    "content": SYSTEM_PROMPT},
            {"role": "user",      "content": user_message},
            {"role": "assistant", "content": assistant_response},
        ]
    }


# ── Retrieval Q&A Generator ────────────────────────────────────────────────

def generate_retrieval_pairs(raw_docs: list[dict]) -> list[dict]:
    """
    Generate Q&A retrieval training pairs using Ollama.
    For each category, picks up to RETRIEVAL_PER_CAT docs and generates
    a realistic user question + answer extracted from the content.
    """
    by_cat: dict[str, list[dict]] = {}
    for doc in raw_docs:
        by_cat.setdefault(doc["category"], []).append(doc)

    pairs: list[dict] = []
    total_cats = len(by_cat)

    print(f"\n{'='*64}")
    print("  Generating Retrieval Q&A Pairs")
    print(f"{'='*64}\n")

    for i, (cat, cat_docs) in enumerate(by_cat.items(), 1):
        sample = random.sample(cat_docs, min(RETRIEVAL_PER_CAT, len(cat_docs)))
        cat_pairs = 0
        print(f"[{i}/{total_cats}] Retrieval pairs for '{cat}' ({len(sample)} docs) …")

        for doc in sample:
            content  = doc["content"]
            filename = doc.get("filename", "")

            prompt = (
                f"Given this document excerpt from a '{cat}' folder:\n\n"
                f"{'Filename: ' + filename + chr(10) if filename else ''}"
                f"{content}\n\n"
                f"Generate a realistic question a user might ask when searching for this "
                f"document, and a concise answer based on the content. "
                f"Output ONLY valid JSON: "
                f'{{\"question\": \"...\", \"answer\": \"...\"}}'
            )

            response = _call_ollama(prompt, timeout=45)
            if not response:
                continue

            # Extract JSON from response
            json_match = re.search(r'\{[^{}]+\}', response, re.DOTALL)
            if not json_match:
                continue
            try:
                qa = json.loads(json_match.group())
                question = qa.get("question", "").strip()
                answer   = qa.get("answer", "").strip()
                if not question or not answer:
                    continue
            except (json.JSONDecodeError, AttributeError):
                continue

            pairs.append({
                "category": cat,
                "filename": filename,
                "content":  content,
                "question": question,
                "answer":   answer,
            })
            cat_pairs += 1

        print(f"  ✓ {cat_pairs} Q&A pairs\n")

    return pairs


# ── Colab Notebook Creator ─────────────────────────────────────────────────

def create_colab_notebook() -> None:
    """Create training_data/FINETUNE_COLAB.ipynb for Unsloth fine-tuning."""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    cells = []

    def code_cell(source: str) -> dict:
        return {
            "cell_type": "code",
            "execution_count": None,
            "metadata": {},
            "outputs": [],
            "source": source,
        }

    def md_cell(source: str) -> dict:
        return {
            "cell_type": "markdown",
            "metadata": {},
            "source": source,
        }

    cells.append(md_cell(
        "# AI Organizer — Fine-Tuning Notebook\n"
        "Fine-tune `llama3.2:3b` on 20,000+ file classification examples using Unsloth.\n"
        "Export as GGUF Q4_K_M for use with Ollama.\n\n"
        "**Runtime**: GPU (T4 or better). Go to Runtime → Change runtime type → GPU."
    ))

    cells.append(code_cell(
        "# Install dependencies\n"
        "!pip install unsloth\n"
        "!pip install --upgrade xformers"
    ))

    cells.append(code_cell(
        "from unsloth import FastLanguageModel\n"
        "import torch\n\n"
        "MAX_SEQ_LENGTH = 2048\n"
        "DTYPE          = None  # auto-detect\n"
        "LOAD_IN_4BIT   = True\n\n"
        "model, tokenizer = FastLanguageModel.from_pretrained(\n"
        '    model_name    = "unsloth/Llama-3.2-3B-Instruct",\n'
        "    max_seq_length = MAX_SEQ_LENGTH,\n"
        "    dtype          = DTYPE,\n"
        "    load_in_4bit   = LOAD_IN_4BIT,\n"
        ")"
    ))

    cells.append(code_cell(
        "# Apply LoRA adapters\n"
        "model = FastLanguageModel.get_peft_model(\n"
        "    model,\n"
        "    r                = 16,\n"
        "    target_modules   = [\"q_proj\", \"k_proj\", \"v_proj\", \"o_proj\",\n"
        "                        \"gate_proj\", \"up_proj\", \"down_proj\"],\n"
        "    lora_alpha       = 16,\n"
        "    lora_dropout     = 0,\n"
        "    bias             = \"none\",\n"
        "    use_gradient_checkpointing = \"unsloth\",\n"
        "    random_state     = 42,\n"
        "    use_rslora       = False,\n"
        "    loftq_config     = None,\n"
        ")"
    ))

    cells.append(code_cell(
        "from datasets import load_dataset\n"
        "from unsloth.chat_templates import get_chat_template\n\n"
        "tokenizer = get_chat_template(tokenizer, chat_template=\"llama-3\")\n\n"
        "# Upload finetune_ready.jsonl to Colab before running\n"
        "dataset = load_dataset(\"json\", data_files=\"finetune_ready.jsonl\", split=\"train\")\n\n"
        "def format_conversations(examples):\n"
        "    texts = [tokenizer.apply_chat_template(\n"
        "        conv, tokenize=False, add_generation_prompt=False\n"
        "    ) for conv in examples[\"conversations\"]]\n"
        "    return {\"text\": texts}\n\n"
        "dataset = dataset.map(format_conversations, batched=True)\n"
        "print(f\"Dataset size: {len(dataset)} examples\")\n"
        "print(dataset[0][\"text\"][:500])"
    ))

    cells.append(code_cell(
        "from trl import SFTTrainer\n"
        "from transformers import TrainingArguments\n"
        "from unsloth import is_bfloat16_supported\n\n"
        "trainer = SFTTrainer(\n"
        "    model             = model,\n"
        "    tokenizer         = tokenizer,\n"
        "    train_dataset     = dataset,\n"
        '    dataset_text_field= "text",\n'
        "    max_seq_length    = MAX_SEQ_LENGTH,\n"
        "    dataset_num_proc  = 2,\n"
        "    packing           = False,\n"
        "    args = TrainingArguments(\n"
        '        output_dir             = "outputs",\n'
        "        per_device_train_batch_size = 4,\n"
        "        gradient_accumulation_steps = 4,\n"
        "        warmup_steps           = 50,\n"
        "        num_train_epochs       = 3,\n"
        "        learning_rate          = 2e-4,\n"
        '        fp16                   = not is_bfloat16_supported(),\n'
        "        bf16                   = is_bfloat16_supported(),\n"
        "        logging_steps          = 10,\n"
        "        optim                  = \"adamw_8bit\",\n"
        "        weight_decay           = 0.01,\n"
        '        lr_scheduler_type      = "cosine",\n'
        "        seed                   = 42,\n"
        "    ),\n"
        ")"
    ))

    cells.append(code_cell(
        "# Phase 1: Classification training\n"
        "print(\"Starting Phase 1: Classification fine-tuning...\")\n"
        "trainer_stats = trainer.train()\n"
        "print(f\"Training complete. Loss: {trainer_stats.training_loss:.4f}\")"
    ))

    cells.append(md_cell(
        "## Phase 2: Retrieval Q&A Training\n"
        "Upload `retrieval_ready.jsonl` for a second training phase on Q&A retrieval pairs."
    ))

    cells.append(code_cell(
        "import json\n\n"
        "# Load retrieval data and convert to conversation format\n"
        "retrieval_convs = []\n"
        "with open(\"retrieval_ready.jsonl\") as f:\n"
        "    for line in f:\n"
        "        item = json.loads(line)\n"
        "        conv = [\n"
        "            {\"role\": \"system\", \"content\": \"You are a file search assistant. Answer questions about file contents.\"},\n"
        "            {\"role\": \"user\",   \"content\": f\"File: {item.get('filename', '')}\\n{item['content']}\\n\\nQuestion: {item['question']}\"},\n"
        "            {\"role\": \"assistant\", \"content\": item['answer']},\n"
        "        ]\n"
        "        retrieval_convs.append({\"conversations\": conv})\n\n"
        "print(f\"Loaded {len(retrieval_convs)} retrieval Q&A pairs\")"
    ))

    cells.append(code_cell(
        "from datasets import Dataset\n\n"
        "retrieval_dataset = Dataset.from_list(retrieval_convs)\n"
        "retrieval_dataset = retrieval_dataset.map(format_conversations, batched=True)\n\n"
        "trainer2 = SFTTrainer(\n"
        "    model             = model,\n"
        "    tokenizer         = tokenizer,\n"
        "    train_dataset     = retrieval_dataset,\n"
        '    dataset_text_field= "text",\n'
        "    max_seq_length    = MAX_SEQ_LENGTH,\n"
        "    dataset_num_proc  = 2,\n"
        "    args = TrainingArguments(\n"
        '        output_dir             = "outputs_retrieval",\n'
        "        per_device_train_batch_size = 4,\n"
        "        gradient_accumulation_steps = 4,\n"
        "        warmup_steps           = 20,\n"
        "        num_train_epochs       = 2,\n"
        "        learning_rate          = 1e-4,\n"
        '        fp16                   = not is_bfloat16_supported(),\n'
        "        bf16                   = is_bfloat16_supported(),\n"
        "        logging_steps          = 10,\n"
        "        optim                  = \"adamw_8bit\",\n"
        "        weight_decay           = 0.01,\n"
        '        lr_scheduler_type      = "cosine",\n'
        "        seed                   = 42,\n"
        "    ),\n"
        ")\n"
        "print(\"Starting Phase 2: Retrieval Q&A fine-tuning...\")\n"
        "trainer2.train()"
    ))

    cells.append(code_cell(
        "# Save model as GGUF Q4_K_M for Ollama\n"
        "print(\"Saving model as GGUF Q4_K_M...\")\n"
        "model.save_pretrained_gguf(\n"
        '    "ai_organizer_llama3_finetuned",\n'
        "    tokenizer,\n"
        '    quantization_method = "q4_k_m",\n'
        ")\n"
        "print(\"Saved! File: ai_organizer_llama3_finetuned-Q4_K_M.gguf\")\n\n"
        "# Download the GGUF file\n"
        "from google.colab import files\n"
        "files.download(\"ai_organizer_llama3_finetuned-Q4_K_M.gguf\")"
    ))

    cells.append(md_cell(
        "## Using the Fine-Tuned Model with Ollama\n\n"
        "```bash\n"
        "# Create a Modelfile\n"
        "cat > Modelfile << 'EOF'\n"
        "FROM ./ai_organizer_llama3_finetuned-Q4_K_M.gguf\n"
        "PARAMETER temperature 0.1\n"
        "PARAMETER num_ctx 4096\n"
        "EOF\n\n"
        "# Register with Ollama\n"
        "ollama create ai-organizer-v2 -f Modelfile\n\n"
        "# Test\n"
        "ollama run ai-organizer-v2 'File content: ...\nAvailable folders: ...\nWhich folder?'\n"
        "```"
    ))

    notebook = {
        "nbformat": 4,
        "nbformat_minor": 5,
        "metadata": {
            "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
            "language_info": {"name": "python", "version": "3.10.0"},
            "accelerator": "GPU",
        },
        "cells": cells,
    }

    with open(NOTEBOOK_FILE, "w", encoding="utf-8") as f:
        json.dump(notebook, f, indent=2, ensure_ascii=False)

    print(f"  ✓ Colab notebook written to {NOTEBOOK_FILE}")


# ── Resume Helpers ─────────────────────────────────────────────────────────

def load_existing_docs() -> tuple[list[dict], dict[str, int]]:
    """Load already-collected docs from RAW_FILE, return docs + counts per category."""
    if not RAW_FILE.exists():
        return [], {}
    docs: list[dict] = []
    with open(RAW_FILE, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    docs.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    counts = Counter(d["category"] for d in docs)
    return docs, dict(counts)


# ── Main Pipeline ─────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="AI Organizer training data pipeline")
    parser.add_argument("--resume",    action="store_true", help="Skip categories already at target")
    parser.add_argument("--notebook",  action="store_true", help="Only (re)create FINETUNE_COLAB.ipynb")
    parser.add_argument("--retrieval", action="store_true", help="Only generate Q&A retrieval pairs")
    parser.add_argument("--cat",       type=str, default="",  help="Comma-separated list of categories to run")
    args = parser.parse_args()

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    random.seed(42)

    # ── Check Ollama connection ──────────────────────────────────────────────
    check_ollama_connection()

    # ── Notebook only ───────────────────────────────────────────────────────
    if args.notebook:
        create_colab_notebook()
        return

    # ── Determine categories to run ─────────────────────────────────────────
    if args.cat:
        run_cats = [c.strip() for c in args.cat.split(",") if c.strip() in TARGETS]
    else:
        run_cats = ALL_CATEGORIES

    # ── Resume: load existing, skip complete ────────────────────────────────
    existing_docs, existing_counts = [], {}
    if args.resume:
        existing_docs, existing_counts = load_existing_docs()
        print(f"  Resuming: found {len(existing_docs)} existing docs across {len(existing_counts)} categories")

    banner = "=" * 64
    print(f"\n{banner}")
    print("  AI Organizer — Training Data Pipeline v2")
    print(f"  {len(run_cats)} categories  |  target: {sum(TARGETS[c] for c in run_cats):,} docs")
    print(f"{banner}\n")

    # ── Retrieval-only mode: load raw and generate Q&A ───────────────────────
    if args.retrieval:
        all_docs, _ = load_existing_docs()
        if not all_docs:
            print("ERROR: No raw_documents.jsonl found. Run the pipeline first.")
            sys.exit(1)
        pairs = generate_retrieval_pairs(all_docs)
        print(f"Writing {len(pairs)} retrieval pairs to {RETRIEVAL_FILE} …")
        with open(RETRIEVAL_FILE, "w", encoding="utf-8") as f:
            for pair in pairs:
                f.write(json.dumps(pair, ensure_ascii=False) + "\n")
        print(f"  ✓ {len(pairs)} retrieval Q&A pairs saved\n")
        return

    # ── Main collection loop ─────────────────────────────────────────────────
    all_docs: list[dict] = list(existing_docs)
    total_cats = len(run_cats)

    for idx, category in enumerate(run_cats, 1):
        target  = TARGETS[category]
        already = existing_counts.get(category, 0)

        if args.resume and already >= target:
            print(f"[{idx}/{total_cats}] SKIP '{category}' — already {already}/{target}\n")
            continue

        need = target - already
        print(f"[{idx}/{total_cats}] '{category}' — collecting {need} docs (have {already}) …")
        docs = fetch_for_category(category, need)
        all_docs.extend(docs)

        print(f"  ✓ {len(docs)} '{category}' documents\n")

        # Checkpoint write every 10 categories
        if idx % 10 == 0:
            print(f"  [checkpoint] Writing {len(all_docs)} docs to {RAW_FILE} …")
            random.shuffle(all_docs)
            with open(RAW_FILE, "w", encoding="utf-8") as f:
                for doc in all_docs:
                    f.write(json.dumps(doc, ensure_ascii=False) + "\n")

    # ── Final write ─────────────────────────────────────────────────────────
    random.shuffle(all_docs)
    print(f"Writing {len(all_docs):,} documents to {RAW_FILE} …")
    with open(RAW_FILE, "w", encoding="utf-8") as f:
        for doc in all_docs:
            f.write(json.dumps(doc, ensure_ascii=False) + "\n")

    print(f"Writing finetune examples to {FINETUNE_FILE} …")
    with open(FINETUNE_FILE, "w", encoding="utf-8") as f:
        for doc in all_docs:
            example = make_finetune_example(doc)
            f.write(json.dumps(example, ensure_ascii=False) + "\n")

    # ── Retrieval Q&A pairs ──────────────────────────────────────────────────
    print("\nGenerating retrieval Q&A pairs (requires Ollama) …")
    pairs = generate_retrieval_pairs(all_docs)
    with open(RETRIEVAL_FILE, "w", encoding="utf-8") as f:
        for pair in pairs:
            f.write(json.dumps(pair, ensure_ascii=False) + "\n")
    print(f"  ✓ {len(pairs)} retrieval pairs saved to {RETRIEVAL_FILE}")

    # ── Create Colab notebook ────────────────────────────────────────────────
    create_colab_notebook()

    # ── Summary ─────────────────────────────────────────────────────────────
    counts = Counter(d["category"] for d in all_docs)
    total  = len(all_docs)

    print(f"\n{banner}")
    print("  CATEGORY DISTRIBUTION SUMMARY")
    print(f"{banner}")
    print(f"  {'Category':<38} {'Got':>4}  {'Target':>6}  {'%':>5}  Bar")
    print(f"  {'-'*38}  {'-'*4}  {'-'*6}  {'-'*5}  ---")

    for cat in ALL_CATEGORIES:
        got    = counts.get(cat, 0)
        tgt    = TARGETS.get(cat, 300)
        pct    = (got / total * 100) if total else 0
        status = "✓" if got >= tgt * 0.8 else "⚠"
        bar    = "█" * min(25, got // 12)
        print(f"  {status} {cat:<37} {got:>4}  {tgt:>6}  {pct:>4.1f}%  {bar}")

    print(f"\n  Total examples    : {total:,}")
    print(f"  raw_documents     : {RAW_FILE}")
    print(f"  finetune_ready    : {FINETUNE_FILE}")
    print(f"  retrieval_ready   : {RETRIEVAL_FILE}")
    print(f"  Colab notebook    : {NOTEBOOK_FILE}")
    print(f"{banner}\n")


if __name__ == "__main__":
    main()
