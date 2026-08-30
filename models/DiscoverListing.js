import mongoose from "mongoose";
const { Schema } = mongoose;

// ── Sub-schemas ────────────────────────────────────────────────────────────────

const HowItWorksStepSchema = new Schema(
  {
    step_number: { type: Number },
    title:       { type: String },
    description: { type: String },
  },
  { _id: false }
);

const PricingPlanSchema = new Schema(
  {
    name:           { type: String },
    price:          { type: String },   // e.g. "$0", "$29", "Custom"
    billing_period: { type: String },   // "forever", "/month", "/year", "one-time"
    is_highlighted: { type: Boolean, default: false },
    features:       [{ type: String }],
  },
  { _id: false }
);

const FounderSchema = new Schema(
  {
    name:    { type: String },
    role:    { type: String },
    twitter: { type: String },
  },
  { _id: false }
);

const AboutSchema = new Schema(
  {
    company_description: { type: String, default: null },
    founded_year:        { type: Number, default: null },
    team_size:           { type: String, default: null }, // e.g. "1-10", "50-200"
    location:            { type: String, default: null },
    founders:            [FounderSchema],
  },
  { _id: false }
);

const ContactSchema = new Schema(
  {
    email:       { type: String, default: null },
    support_url: { type: String, default: null },
    docs_url:    { type: String, default: null },
    status_url:  { type: String, default: null },
  },
  { _id: false }
);

const SocialsSchema = new Schema(
  {
    twitter:      { type: String, default: null }, // @handle or full URL
    github:       { type: String, default: null },
    linkedin:     { type: String, default: null },
    product_hunt: { type: String, default: null },
    discord:      { type: String, default: null },
    youtube:      { type: String, default: null },
    instagram:    { type: String, default: null },
    facebook:     { type: String, default: null },
  },
  { _id: false }
);

// ── Main schema ────────────────────────────────────────────────────────────────

const DiscoverListingSchema = new Schema({
  user_id:     { type: Schema.Types.ObjectId, ref: "users", required: true },
  website_url: { type: String, required: true },

  // ── SEO slug (URL-friendly unique identifier)
  slug: { type: String, unique: true, sparse: true, lowercase: true, trim: true, default: null },

  // ── Core identity
  name:             { type: String, default: null },
  tagline:          { type: String, default: null },
  description:      { type: String, default: null },
  problem_statement:{ type: String, default: null },
  target_audience:  { type: String, default: null },
  icp:              [{ type: String }],
  category:         { type: String, default: null },    // primary category
  category_tags:    [{ type: String }],                 // e.g. ["SaaS","AI","NoCode"]
  tags:             [{ type: String }],                 // lowercase keyword tags

  likes:     [{ type: Schema.Types.ObjectId, ref: "users" }],


  // ── Discovered pages (sitemap or extracted internal links)
  sitemap_urls: [{ type: String }],

  // ── Media
  logo:        { type: String, default: null },
  og_image:    { type: String, default: null },
  screenshots: [{ type: String }],

  // ── Product details
  key_features:  [{ type: String }],
  how_it_works:  [HowItWorksStepSchema],
  integrations:  [{ type: String }],
  has_api:       { type: Boolean, default: null },
  is_open_source:{ type: Boolean, default: null },

  // ── Pricing
  pricing_model: {
    type: String,
    enum: ["free", "freemium", "paid", "usage-based", "one-time", null],
    default: null,
  },
  has_free_plan:   { type: Boolean, default: null },
  has_free_trial:  { type: Boolean, default: null },
  free_trial_days: { type: Number,  default: null },
  pricing_plans:   [PricingPlanSchema],

  // ── About
  about:   { type: AboutSchema,   default: () => ({}) },

  // ── Contact
  contact: { type: ContactSchema, default: () => ({}) },

  // ── Socials
  socials: { type: SocialsSchema, default: () => ({}) },

  // ── Meta
  status: {
    type: String,
    enum: ["pending", "published", "failed"],
    default: "published",
  },
  analysis_confidence: { type: Number, default: null },

  // ── Pre-computed ranking scores (refreshed every 10 min by the Agenda job) ──
  // trending_score: time-decay weighted (HN-style), based on last 30d analytics
  // top_score:      all-time engagement, based on last 90d analytics
  // Both are 0 for brand-new listings until the first job run after listing
  trending_score:    { type: Number, default: 0 },
  top_score:         { type: Number, default: 0 },
  scores_updated_at: { type: Date,   default: null },

  // ── Fair exposure fields (Phases 1–4) ────────────────────────────────────────
  // total_impressions:  cached lifetime impression count (updated by score job)
  // needs_exposure:     true until listing reaches 100 impressions (exploration slot)
  // intake_until:       72h window from publish — freshness + exploration boost active
  // intake_batch_group: 0–9 rotation group for fair distribution on high-volume days
  total_impressions:   { type: Number,  default: 0    },
  needs_exposure:      { type: Boolean, default: true  },
  intake_until:        { type: Date,    default: null  },
  intake_batch_group:  { type: Number,  default: 0     },

  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

DiscoverListingSchema.index({ slug: 1 });
DiscoverListingSchema.index({ user_id: 1 });
DiscoverListingSchema.index({ category: 1 });
DiscoverListingSchema.index({ category_tags: 1 });
DiscoverListingSchema.index({ tags: 1 });
DiscoverListingSchema.index({ created_at: -1 });
DiscoverListingSchema.index({ likes: 1 });
DiscoverListingSchema.index({ trending_score: -1 }); // for Trending tab sort
DiscoverListingSchema.index({ top_score: -1 });      // for Ranked tab sort
DiscoverListingSchema.index({ intake_until: 1 });    // for intake bucket query
DiscoverListingSchema.index({ needs_exposure: 1 });  // for exploration slot query

export default mongoose.model("DiscoverListing", DiscoverListingSchema, "discover_listings");
