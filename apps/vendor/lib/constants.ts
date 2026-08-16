// Shared vendor constants.
// The demo seed provisions a single restaurant, but vendor pages must no
// longer assume a fixed restaurant id. The signed-in vendor's active
// restaurant is resolved dynamically via GET /api/vendor/restaurants and
// stored in lib/store.ts. See lib/api.ts fetchVendorRestaurants().
