-- ROOMFIT PostgreSQL schema (Supabase-compatible). Not used by the static MVP, which stores data
-- in the browser only. This is the target model for accounts and cloud sync.
-- All lengths are centimetres, money is INR in paise-free integers.

create extension if not exists pgcrypto;

create type provenance as enum ('verified', 'estimated', 'unknown');
create type wall_side as enum ('N', 'E', 'S', 'W');
create type opening_type as enum ('door', 'window');
create type facing as enum ('N', 'E', 'S', 'W');

-- users: managed by auth (Supabase auth.users); profile row per user
create table profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now()
);

create table rooms (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null default 'My room',
  room_type text not null default 'other',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index rooms_owner_idx on rooms (owner_id);

-- every dimension carries where it came from
create table room_measurements (
  room_id uuid primary key references rooms (id) on delete cascade,
  width_cm numeric(7,1) check (width_cm between 50 and 5000),
  length_cm numeric(7,1) check (length_cm between 50 and 5000),
  height_cm numeric(6,1) check (height_cm between 150 and 1000),
  width_source provenance not null default 'unknown',
  length_source provenance not null default 'unknown',
  height_source provenance not null default 'unknown',
  measured_at timestamptz not null default now()
);

create table room_openings (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms (id) on delete cascade,
  kind opening_type not null,
  wall wall_side not null,
  offset_cm numeric(7,1) not null check (offset_cm >= 0),
  width_cm numeric(6,1) not null check (width_cm > 0),
  height_cm numeric(6,1),
  sill_cm numeric(6,1),
  hinge text check (hinge in ('start', 'end')),
  swing text check (swing in ('in', 'out', 'slide')),
  source provenance not null default 'verified'
);
create index room_openings_room_idx on room_openings (room_id);

create table room_obstacles (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms (id) on delete cascade,
  label text not null,
  x_cm numeric(7,1) not null, y_cm numeric(7,1) not null,
  width_cm numeric(6,1) not null, depth_cm numeric(6,1) not null, height_cm numeric(6,1),
  source provenance not null default 'verified'
);
create index room_obstacles_room_idx on room_obstacles (room_id);

-- future delivery path: room → door → corridor → lift → building entry
create table path_nodes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('room', 'door', 'corridor', 'stair', 'lift', 'entry')),
  room_id uuid references rooms (id) on delete cascade,
  clear_width_cm numeric(6,1), clear_height_cm numeric(6,1), depth_cm numeric(6,1),
  turn_radius_cm numeric(6,1),
  source provenance not null default 'unknown'
);
create table path_edges (
  from_node uuid not null references path_nodes (id) on delete cascade,
  to_node uuid not null references path_nodes (id) on delete cascade,
  primary key (from_node, to_node)
);

-- catalog (shared, read-only for users)
create table furniture (
  id text primary key,
  name text not null,
  category text not null,
  style text[] not null default '{}',
  tags text[] not null default '{}',
  price_inr integer check (price_inr >= 0),
  product_url text,
  image_url text,
  source text not null,              -- e.g. 'roomfit-sample-catalog', retailer feed id
  is_sample boolean not null default true,
  price_verified_at timestamptz      -- null = not a verified price
);
create index furniture_category_idx on furniture (category);

create table furniture_dimensions (
  furniture_id text primary key references furniture (id) on delete cascade,
  width_cm numeric(6,1) not null, depth_cm numeric(6,1) not null, height_cm numeric(6,1) not null,
  elevation_cm numeric(6,1) not null default 0,
  clearance_front_cm numeric(5,1) not null default 0,
  clearance_side_cm numeric(5,1) not null default 0,
  clearance_back_cm numeric(5,1) not null default 0,
  door_clearance_cm numeric(5,1) not null default 0,
  drawer_clearance_cm numeric(5,1) not null default 0,
  requires_wall_mount boolean not null default false
);

create table user_preferences (
  user_id uuid primary key references auth.users (id) on delete cascade,
  walk_width_cm integer not null default 60,
  accessibility boolean not null default false,
  wall_mount_allowed boolean not null default true,
  default_budget_inr integer
);

create table layouts (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  strategy text not null,            -- floor | storage | workspace | balanced | cheapest | manual
  budget_inr integer,
  total_inr integer not null default 0,
  valid boolean not null,            -- result of the geometry engine at save time
  validation jsonb not null,         -- engine output (checks, required/available values)
  created_at timestamptz not null default now()
);
create index layouts_room_idx on layouts (room_id);
create index layouts_owner_idx on layouts (owner_id);

create table layout_items (
  id uuid primary key default gen_random_uuid(),
  layout_id uuid not null references layouts (id) on delete cascade,
  furniture_id text references furniture (id),
  custom_name text,
  x_cm numeric(7,1) not null, y_cm numeric(7,1) not null,
  facing facing not null,
  paired_with uuid references layout_items (id) on delete set null,
  is_existing boolean not null default false
);
create index layout_items_layout_idx on layout_items (layout_id);

create table layout_constraints (
  layout_id uuid primary key references layouts (id) on delete cascade,
  constraints jsonb not null default '{}'::jsonb,   -- e.g. {"desk_max_width_cm":120,"bed_avoid_window":true}
  rules jsonb not null default '{}'::jsonb
);

create table saved_designs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  room_id uuid not null references rooms (id) on delete cascade,
  layout_id uuid references layouts (id) on delete set null,
  name text not null,
  share_token text unique,           -- null = private
  created_at timestamptz not null default now()
);
create index saved_designs_owner_idx on saved_designs (owner_id);

-- Room photos are NOT stored. If storage is ever added it must be opt-in, private, and auto-expiring.

-- Row-level security: every user sees only their own rows.
alter table profiles enable row level security;
alter table rooms enable row level security;
alter table room_measurements enable row level security;
alter table room_openings enable row level security;
alter table room_obstacles enable row level security;
alter table path_nodes enable row level security;
alter table path_edges enable row level security;
alter table user_preferences enable row level security;
alter table layouts enable row level security;
alter table layout_items enable row level security;
alter table layout_constraints enable row level security;
alter table saved_designs enable row level security;
alter table furniture enable row level security;
alter table furniture_dimensions enable row level security;

create policy own_profile on profiles for all using (id = (select auth.uid())) with check (id = (select auth.uid()));
create policy own_rooms on rooms for all using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy own_measurements on room_measurements for all using (exists (select 1 from rooms r where r.id = room_id and r.owner_id = (select auth.uid())));
create policy own_openings on room_openings for all using (exists (select 1 from rooms r where r.id = room_id and r.owner_id = (select auth.uid())));
create policy own_obstacles on room_obstacles for all using (exists (select 1 from rooms r where r.id = room_id and r.owner_id = (select auth.uid())));
create policy own_nodes on path_nodes for all using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy own_edges on path_edges for all using (exists (select 1 from path_nodes n where n.id = from_node and n.owner_id = (select auth.uid())));
create policy own_prefs on user_preferences for all using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy own_layouts on layouts for all using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy own_layout_items on layout_items for all using (exists (select 1 from layouts l where l.id = layout_id and l.owner_id = (select auth.uid())));
create policy own_layout_constraints on layout_constraints for all using (exists (select 1 from layouts l where l.id = layout_id and l.owner_id = (select auth.uid())));
create policy own_designs on saved_designs for all using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy catalog_read on furniture for select using (true);
create policy catalog_dims_read on furniture_dimensions for select using (true);

-- ===================== AI Shop (real-world product discovery) =====================
-- Products retrieved from search are normalized here. Dimensions are verified only when the listing states them.
-- Prices/availability are snapshots: always shown with retrieved_at, never treated as current.

create table product_sources (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('gemini_web_search', 'retailer_api', 'affiliate_feed', 'internal_catalog')),
  name text not null,
  base_url text,
  terms_url text,                     -- usage terms the integration complies with
  created_at timestamptz not null default now()
);

create table products (
  id uuid primary key default gen_random_uuid(),
  source_id uuid references product_sources (id) on delete set null,
  name text not null,
  brand text,
  retailer text,
  category text not null,
  price numeric(12,2) check (price >= 0),
  currency text default 'INR',
  width_cm numeric(6,1), depth_cm numeric(6,1), height_cm numeric(6,1),
  dimensions_text text,               -- as printed on the listing
  dimensions_verified boolean not null default false,
  image_url text,
  product_url text not null,
  source_url text not null,
  link_status text check (link_status in ('ok', 'missing', 'unknown', 'unchecked')),
  availability text,                  -- only when reported by the source
  retrieved_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (product_url)
);
create index products_category_idx on products (category);
create index products_retrieved_idx on products (retrieved_at);

create table product_searches (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  room_id uuid references rooms (id) on delete cascade,
  query text,
  request jsonb not null,             -- ProductSearchRequest
  room_context jsonb not null,        -- geometry only, never photos
  cache_key text not null,
  provider text not null,
  searched_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '6 hours'
);
create index product_searches_owner_idx on product_searches (owner_id);
create index product_searches_cache_idx on product_searches (cache_key, expires_at);

create table product_fit_results (
  id uuid primary key default gen_random_uuid(),
  search_id uuid not null references product_searches (id) on delete cascade,
  product_id uuid not null references products (id) on delete cascade,
  status text not null check (status in ('fits', 'does_not_fit', 'unknown', 'partial')),
  confidence text not null check (confidence in ('verified', 'partial', 'unknown')),
  result jsonb not null,              -- engine output: facts, shortfalls, violations
  created_at timestamptz not null default now()
);
create index product_fit_results_search_idx on product_fit_results (search_id);
create index product_fit_results_product_idx on product_fit_results (product_id);

create table saved_products (
  owner_id uuid not null references auth.users (id) on delete cascade,
  product_id uuid not null references products (id) on delete cascade,
  note text,
  created_at timestamptz not null default now(),
  primary key (owner_id, product_id)
);
create index saved_products_product_idx on saved_products (product_id);

create table room_products (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms (id) on delete cascade,
  layout_item_id uuid references layout_items (id) on delete set null,
  product_id uuid not null references products (id) on delete cascade,
  placed_at timestamptz not null default now()
);
create index room_products_room_idx on room_products (room_id);
create index room_products_product_idx on room_products (product_id);
create index room_products_item_idx on room_products (layout_item_id);

alter table product_sources enable row level security;
alter table products enable row level security;
alter table product_searches enable row level security;
alter table product_fit_results enable row level security;
alter table saved_products enable row level security;
alter table room_products enable row level security;

-- normalized listings are public facts; only the service role writes them
create policy product_sources_read on product_sources for select using (true);
create policy products_read on products for select using (true);
create policy own_product_searches on product_searches for all using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy own_product_fit_results on product_fit_results for all using (exists (select 1 from product_searches s where s.id = search_id and s.owner_id = (select auth.uid())));
create policy own_saved_products on saved_products for all using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy own_room_products on room_products for all using (exists (select 1 from rooms r where r.id = room_id and r.owner_id = (select auth.uid())));
