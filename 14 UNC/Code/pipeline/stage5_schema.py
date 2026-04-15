"""
Shared JSON schema for Stage 5 MedSum-format producers.

Both `stage5_chronology_docx.py` (Medical Chronology) and
`stage5_delivery_note.py` (Delivery Note) consume the same `ChronologyDoc`
JSON object so the two deliverables stay in sync.

The schema is documented with dataclasses for IDE/type-checking support, but
the producers accept plain dicts — any AI pipeline that fills the fields
below can drive the output generators.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional, Dict


# ── Core sub-structures ────────────────────────────────────────────────────

@dataclass
class PatientInfo:
    """Patient + case intake metadata."""
    name: str
    dob: Optional[str] = None                  # "MM/DD/YYYY"
    contact_first_name: str = "Marc"           # recipient of Delivery Note


@dataclass
class Treatments:
    """Treatments rendered — each category is an optional list of strings."""
    medications: List[str] = field(default_factory=list)
    procedures: List[str] = field(default_factory=list)
    therapy: List[str] = field(default_factory=list)
    imaging: List[str] = field(default_factory=list)
    labs: List[str] = field(default_factory=list)


@dataclass
class InjuryReport:
    """First major table in the Medical Chronology (2 cols: DESCRIPTION | DETAILS)."""
    prior_injury_details: List[str] = field(default_factory=list)
    dates_of_injury: List[str] = field(default_factory=list)   # ["MM/DD/YYYY"] or list for multi-DOI
    incident_type: str = "Injury"                              # "Motor Vehicle Accident", "Fall Accident", etc.
    description: str = ""
    diagnoses: List[str] = field(default_factory=list)
    treatments: Treatments = field(default_factory=Treatments)


@dataclass
class HistoryLine:
    """One of 5 Patient History lines. `text` is verbatim; `pdf_ref` is the page ref string."""
    text: str = "Not available."
    pdf_ref: Optional[str] = None


@dataclass
class PatientHistory:
    """The 5-line Patient History section, between Flow of events and Detailed Summary."""
    past_medical: HistoryLine = field(default_factory=HistoryLine)
    surgical: HistoryLine = field(default_factory=HistoryLine)
    family: HistoryLine = field(default_factory=HistoryLine)
    social: HistoryLine = field(default_factory=HistoryLine)
    allergy: HistoryLine = field(default_factory=HistoryLine)


@dataclass
class FlowEntry:
    """One date-range summary in the Flow of events section."""
    provider_group: str = ""          # "North Florida Regional Medical Center" / "Multiple Provider"
    date_range: str = ""              # "05/17/2021-05/18/2021" or "05/17/2021"
    summary: str = ""                 # prose summary
    reviewer_comment: Optional[str] = None  # italic, rendered between groups


@dataclass
class Encounter:
    """One row in the Detailed Summary table."""
    date: str = ""                    # "MM/DD/YYYY" or "MM/DD/YYYY-MM/DD/YYYY"
    facility: str = ""                # e.g. "North Florida Regional Medical Center"
    providers: List[str] = field(default_factory=list)  # ["Amit Rawal, M.D.", "PA-C"]
    medical_events: str = ""          # verbatim transcription — may use sub-headings
    pdf_ref: str = ""                 # "1-10" or "184-195, 432-443"
    # Optional group-header row that appears ABOVE this encounter in the table.
    # Used by MedSum to group consecutive encounters under a shared heading.
    # Set group_header=True on the first encounter of a new facility/date group.
    group_header: bool = False
    group_header_text: Optional[str] = None  # "North Florida Regional Medical Center / 05/17/2021-05/18/2021"


@dataclass
class MissingRecord:
    """One row in the Missing Records table (appears in both Delivery Note and Chronology)."""
    date_period: str = ""
    provider: str = ""
    records_needed: str = ""
    confirmatory_or_probable: str = "Confirmatory"  # or "Probable"
    statement: str = ""
    pdf_reference: str = ""


@dataclass
class DatedStatement:
    """Causation / Disability entries in the Delivery Note."""
    date: str = ""
    text: str = ""


# ── Top-level container ────────────────────────────────────────────────────

@dataclass
class ChronologyDoc:
    """Full document model consumed by both Stage 5 producers."""
    patient: PatientInfo = field(default_factory=lambda: PatientInfo(name=""))
    general_instructions: List[str] = field(default_factory=list)
    injury_report: InjuryReport = field(default_factory=InjuryReport)
    flow_of_events: List[FlowEntry] = field(default_factory=list)
    patient_history: PatientHistory = field(default_factory=PatientHistory)
    encounters: List[Encounter] = field(default_factory=list)

    # Delivery-Note-only fields
    case_focus: str = ""                                     # 1-3 paragraph prose
    causation_statements: List[DatedStatement] = field(default_factory=list)
    disability_statements: List[DatedStatement] = field(default_factory=list)
    missing_records: List[MissingRecord] = field(default_factory=list)

    # Optional flag: if True, the Delivery Note will say
    # "There are no critical missing medical records."
    no_missing_records: bool = False


# ── dict <-> dataclass helpers (producers accept either) ───────────────────

def from_dict(d: Dict) -> ChronologyDoc:
    """Build a ChronologyDoc from a plain dict (AI-generated JSON)."""
    def _hl(x):
        return HistoryLine(text=x.get("text", "Not available."),
                           pdf_ref=x.get("pdf_ref"))

    def _patient(x):
        return PatientInfo(**{k: v for k, v in x.items()
                              if k in PatientInfo.__dataclass_fields__})

    def _treatments(x):
        return Treatments(**{k: v for k, v in (x or {}).items()
                             if k in Treatments.__dataclass_fields__})

    def _injury(x):
        x = x or {}
        data = {k: v for k, v in x.items()
                if k in InjuryReport.__dataclass_fields__ and k != "treatments"}
        data["treatments"] = _treatments(x.get("treatments"))
        return InjuryReport(**data)

    def _history(x):
        x = x or {}
        return PatientHistory(
            past_medical=_hl(x.get("past_medical", {})),
            surgical=_hl(x.get("surgical", {})),
            family=_hl(x.get("family", {})),
            social=_hl(x.get("social", {})),
            allergy=_hl(x.get("allergy", {})),
        )

    return ChronologyDoc(
        patient=_patient(d.get("patient", {"name": ""})),
        general_instructions=list(d.get("general_instructions", [])),
        injury_report=_injury(d.get("injury_report")),
        flow_of_events=[FlowEntry(**{k: v for k, v in (e or {}).items()
                                     if k in FlowEntry.__dataclass_fields__})
                        for e in d.get("flow_of_events", [])],
        patient_history=_history(d.get("patient_history")),
        encounters=[Encounter(**{k: v for k, v in (e or {}).items()
                                 if k in Encounter.__dataclass_fields__})
                    for e in d.get("encounters", [])],
        case_focus=d.get("case_focus", ""),
        causation_statements=[DatedStatement(**e) for e in d.get("causation_statements", [])],
        disability_statements=[DatedStatement(**e) for e in d.get("disability_statements", [])],
        missing_records=[MissingRecord(**{k: v for k, v in (e or {}).items()
                                          if k in MissingRecord.__dataclass_fields__})
                         for e in d.get("missing_records", [])],
        no_missing_records=bool(d.get("no_missing_records", False)),
    )
