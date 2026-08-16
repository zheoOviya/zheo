import type { MenuItemDTO, RestaurantDTO } from "../repositories/catalogRepository";

// ============================================
// Shared catalog seed data (single source of truth).
// Memory mode feeds these into MemoryCatalogRepository;
// Postgres mode upserts them via seed/catalogSeed.ts.
// lat/lng are the P04 traffic-ETA pickup origins (Mumbai, IN).
// ============================================

/** Seed vendor owners referenced by SEED_RESTAURANTS.owner_id. */
export interface SeedOwner {
  id: string;
  phone: string;
  role: string;
}

export const SEED_OWNERS: SeedOwner[] = [
  {
    id: "e0000000-0000-4000-a000-000000000001",
    phone: "+919876000101",
    role: "VENDOR_OWNER",
  },
  {
    id: "e0000000-0000-4000-a000-000000000002",
    phone: "+919876000102",
    role: "VENDOR_OWNER",
  },
  {
    id: "e0000000-0000-4000-a000-000000000003",
    phone: "+919876000103",
    role: "VENDOR_OWNER",
  },
];

export const SEED_RESTAURANTS: RestaurantDTO[] = [
  {
    id: "a0000000-0000-4000-8000-000000000001",
    name: "Biryani House",
    gst_number: "27AABCB1234A1Z5",
    fssai_license: "11522999000001",
    owner_id: "e0000000-0000-4000-a000-000000000001",
    commission_rate: 0.08,
    is_active: true,
    lat: 19.076,
    lng: 72.8777,
    pickup_eta_min: 25,
    rating: 4.5,
    cuisines: ["North Indian", "Biryani"],
    price_for_one: 300,
    cover_image: "https://picsum.photos/seed/biryani-house/600/450",
  },
  {
    id: "a0000000-0000-4000-8000-000000000002",
    name: "Green Bowl",
    gst_number: "27AACCG5678B1Z3",
    fssai_license: "11522999000002",
    owner_id: "e0000000-0000-4000-a000-000000000002",
    commission_rate: 0.08,
    is_active: true,
    lat: 19.1136,
    lng: 72.8697,
    pickup_eta_min: 15,
    rating: 4.2,
    cuisines: ["Healthy", "Salads"],
    price_for_one: 250,
    cover_image: "https://picsum.photos/seed/green-bowl/600/450",
  },
  {
    id: "a0000000-0000-4000-8000-000000000003",
    name: "Closed Kitchen",
    gst_number: "27AADDH9012C1Z7",
    fssai_license: "11522999000003",
    owner_id: "e0000000-0000-4000-a000-000000000003",
    commission_rate: 0.05,
    is_active: false,
    lat: 18.9647,
    lng: 72.8258,
    pickup_eta_min: 30,
    rating: 3.9,
    cuisines: ["Continental"],
    price_for_one: 200,
    cover_image: "https://picsum.photos/seed/closed-kitchen/600/450",
  },
];

export const SEED_MENU: MenuItemDTO[] = [
  {
    id: "b0000000-0000-4000-8000-000000000001",
    restaurant_id: "a0000000-0000-4000-8000-000000000001",
    name: "Chicken Biryani",
    price: 220,
    description: "Hyderabadi-style chicken biryani with saffron rice.",
    dietary_tags: { NON_VEG: true },
    customizations: [],
    image_url: "https://picsum.photos/seed/chicken-biryani/400/300",
    pos_item_id: null,
    spice_level: 5,
    is_available: true,
  },
  {
    id: "b0000000-0000-4000-8000-000000000002",
    restaurant_id: "a0000000-0000-4000-8000-000000000001",
    name: "Veg Biryani",
    price: 180,
    description: "Seasonal vegetables slow-cooked with basmati rice.",
    dietary_tags: { VEG: true, JAIN: true },
    customizations: [],
    image_url: "https://picsum.photos/seed/veg-biryani/400/300",
    pos_item_id: null,
    spice_level: 2,
    is_available: true,
  },
  {
    id: "b0000000-0000-4000-8000-000000000003",
    restaurant_id: "a0000000-0000-4000-8000-000000000002",
    name: "Paneer Wrap",
    price: 160,
    description: "Paneer tikka wrapped in a warm whole-wheat roti.",
    dietary_tags: { VEG: true },
    customizations: [],
    image_url: "https://picsum.photos/seed/paneer-wrap/400/300",
    pos_item_id: null,
    spice_level: 1,
    is_available: true,
  },
  {
    id: "b0000000-0000-4000-8000-000000000004",
    restaurant_id: "a0000000-0000-4000-8000-000000000002",
    name: "Chicken Shawarma",
    price: 190,
    description: "Chicken shawarma with garlic sauce.",
    dietary_tags: { NON_VEG: true },
    customizations: [],
    image_url: "https://picsum.photos/seed/chicken-shawarma/400/300",
    pos_item_id: null,
    spice_level: 3,
    is_available: true,
  },
  {
    id: "b0000000-0000-4000-8000-000000000005",
    restaurant_id: "a0000000-0000-4000-8000-000000000002",
    name: "Unavailable Dish",
    price: 99,
    description: null,
    dietary_tags: { VEG: true },
    customizations: [],
    image_url: "https://picsum.photos/seed/unavailable-dish/400/300",
    pos_item_id: null,
    spice_level: 1,
    is_available: false,
  },
];
