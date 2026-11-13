export type Cell = { hpix: number; ra_deg: number; dec_deg: number; p_surviving: number; p_remaining: number; searched: boolean };

export type MapSummary = {
  frac_excluded_prior: number;
  frac_excluded_deepfield: number;
  frac_excluded_deepfield_potential: number;
  frac_excluded_total: number;
  n_patches_searched: number;
  n_votes: number;
  patches?: Target[];
  bundle_kind: string;
  population_version?: string | null;
  epoch_mjd?: string | number | null;
  nside: number;
  source?: string | null;
  explanation: string;
  cells?: Cell[];
};

export type Target = {
  patch_id: string; rank: number; ra_deg: number; dec_deg: number; radius_deg: number; hpix: number;
  p_surviving: number; n_exposures: number; mjd_start: number; mjd_end: number; visit_label: string;
  status: string; score: number; source: string; crowd_credit?: number; exclusion_share?: number;
};

export type Stamps = { singles: string[]; stack: string | null; static: string | null; meta?: Record<string, unknown> };

export type Candidate = {
  candidate_id: string; patch_id: string; ra_deg: number; dec_deg: number;
  is_simulated: boolean; injection_id: string | null; injected_mag: number | null; injected_distance_au: number | null;
  snr_stack: number; snr_single_max: number; best_distance_au: number;
  best_rate_ra_arcsec_day: number; best_rate_dec_arcsec_day: number;
  flux_mjysr: number; n_epochs: number; n_bands: number;
  methane_score: number; template_best: string; ml_score: number | null; rule_score: number;
  crowd_p_real: number; n_votes: number; status: string; known_object: string | null;
  stamp_dir: string; dossier_path: string; source: string; created_mjd: number;
  stamps: Stamps; dossier_url: string;
};

export type SpectrumRow = {
  candidate_id: string; obs_id: string; detector: number; mjd: number; wavelength_um: number; bandwidth_um: number;
  flux_mjysr: number; flux_err_mjysr: number; model_planet: number; model_asteroid: number; model_star: number; source: string;
};

export type Dossier = {
  candidate_id: string; generated_at: string; generator: string; is_simulated: boolean;
  scout: { summary: string; facts: string[] };
  skeptic: { checks: { name: string; result: string }[]; verdict: string };
  reporter: { headline: string; dossier_md: string; mpc_report: string | null };
  verdict: string; confidence: number; sources: string[];
};

export type CompletenessRow = {
  patch_id: string; axis: string; bin_lo: number; bin_hi: number; n_injected: number; n_recovered: number;
  fraction: number; snr_threshold: number; source: string;
};

export type Task = {
  task_id: string; user_id: string;
  candidate: Pick<Candidate, "candidate_id" | "patch_id" | "n_epochs" | "n_bands" | "snr_stack" | "snr_single_max" | "best_distance_au" | "ml_score" | "source">;
  stamps: Stamps; prompt: string;
  user: UserStats;
};

export type UserStats = { points: number; reliability: number; n_test: number; n_votes: number };

export type Answer = "real" | "artifact" | "nothing";

export type VoteResult = {
  candidate_id: string; is_test: boolean; answer: Answer;
  truth?: string; correct?: boolean;
  reveal?: { is_simulated: boolean; injected_mag: number | null; injected_distance_au: number | null; status: string };
  consensus?: { p_real: number; n_votes: number };
  points_awarded: number; user: UserStats;
  map: { frac_excluded_prior: number; frac_excluded_deepfield: number; frac_excluded_total: number; n_votes: number };
};

export type Manifest = {
  version: number; rule: string;
  datasets: { id: string; name: string; owner: string; country: string; licence: string; access: string[]; domains: string[]; used_for: string; doi?: string; md5?: string }[];
  infrastructure_domains: string[];
};
