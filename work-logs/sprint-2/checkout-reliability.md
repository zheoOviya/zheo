## Sprint 2 -- Checkout & Cart Reliability

### Goal
Fix checkout gaps and improve cart reliability with pickup slots, cart expiry, and enhanced empty states.

---

### Tasks

- **[I-06]** Pickup Slot Selection -- DB migration for `scheduled_pickup_time`, pickup slots API, checkout slot selector
- **[I-08]** Cart Expiry Countdown -- Backend `expires_at` in cart response, frontend countdown timer, expiry clear + toast
- **[I-09]** Enhanced Empty States -- Reusable `EmptyState` component, 4 scenarios (empty cart, order history, menu unavailable, search no results)

### DB Migration
- `0007_pickup_slots.sql`: Adds `scheduled_pickup_time TIMESTAMPTZ` to `orders` table
