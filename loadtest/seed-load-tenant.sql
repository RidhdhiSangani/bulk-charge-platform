-- Optional: a 50,000-shipment tenant for load testing (the demo seed has ~4.5k per tenant).
--   docker compose exec -T postgres psql -U shipmnts -d bulk_charge < loadtest/seed-load-tenant.sql
INSERT INTO tenants (id, name) VALUES ('tnt_load', 'Load Test') ON CONFLICT DO NOTHING;
INSERT INTO shipments
  (tenant_id, shipment_no, trade_type, origin_port, destination_port, container_count,
   chargeable_weight, customer_id, status, billing_currency, is_billed)
SELECT 'tnt_load', 'LD-' || lpad(g::text, 6, '0'), 'export', 'INNSA', 'NLRTM', 1 + (g % 5),
       1000 + (g % 7000), 'CUST-' || lpad((g % 50)::text, 3, '0'), 'in_transit',
       (ARRAY['USD','INR','EUR'])[1 + g % 3], false
FROM generate_series(1, 50000) g
ON CONFLICT DO NOTHING;
