-- Launch reference data (DECISIONS D-003, D-004). Zones are placeholders until the
-- Karnataka minimum-wage notification is confirmed (LEGAL_CHECKLIST L-04).

INSERT INTO cities (code, name, state_code, wage_zone, center, radius_km) VALUES
  ('BLR', 'Bengaluru', 'KA', 'A', ST_GeogFromText('POINT(77.5946 12.9716)'), 50),
  ('MYS', 'Mysuru', 'KA', 'B', ST_GeogFromText('POINT(76.6394 12.2958)'), 25),
  ('MLR', 'Mangaluru', 'KA', 'B', ST_GeogFromText('POINT(74.8560 12.9141)'), 25),
  ('HBL', 'Hubballi-Dharwad', 'KA', 'B', ST_GeogFromText('POINT(75.1240 15.3647)'), 30);

INSERT INTO skills (code, name_i18n, min_wage_category) VALUES
  ('packing',          '{"en":"Packing","hi":"पैकिंग","kn":"ಪ್ಯಾಕಿಂಗ್"}', 'unskilled'),
  ('loading',          '{"en":"Loading / unloading","hi":"लोडिंग / अनलोडिंग","kn":"ಲೋಡಿಂಗ್"}', 'unskilled'),
  ('billing_software', '{"en":"Billing software","hi":"बिलिंग सॉफ्टवेयर","kn":"ಬಿಲ್ಲಿಂಗ್ ಸಾಫ್ಟ್‌ವೇರ್"}', 'semi_skilled'),
  ('customer_service', '{"en":"Customer service","hi":"ग्राहक सेवा","kn":"ಗ್ರಾಹಕ ಸೇವೆ"}', 'unskilled'),
  ('event_setup',      '{"en":"Event setup","hi":"इवेंट सेटअप","kn":"ಕಾರ್ಯಕ್ರಮ ಸಿದ್ಧತೆ"}', 'unskilled'),
  ('housekeeping',     '{"en":"Housekeeping","hi":"हाउसकीपिंग","kn":"ಹೌಸ್‌ಕೀಪಿಂಗ್"}', 'unskilled'),
  ('delivery',         '{"en":"Delivery","hi":"डिलीवरी","kn":"ಡೆಲಿವರಿ"}', 'unskilled');

INSERT INTO role_categories (code, name_i18n, wage_category, hazard_level, allowed_skills) VALUES
  ('warehouse_packing', '{"en":"Warehouse packing","hi":"गोदाम पैकिंग","kn":"ಗೋದಾಮು ಪ್ಯಾಕಿಂಗ್"}', 'unskilled', 'low', '{packing,loading}'),
  ('warehouse_loading', '{"en":"Warehouse loading","hi":"गोदाम लोडिंग","kn":"ಗೋದಾಮು ಲೋಡಿಂಗ್"}', 'unskilled', 'medium', '{loading,packing}'),
  ('retail_floor',      '{"en":"Retail floor staff","hi":"दुकान फ्लोर स्टाफ","kn":"ಅಂಗಡಿ ಸಿಬ್ಬಂದಿ"}', 'unskilled', 'low', '{customer_service,packing}'),
  ('billing_counter',   '{"en":"Billing counter","hi":"बिलिंग काउंटर","kn":"ಬಿಲ್ಲಿಂಗ್ ಕೌಂಟರ್"}', 'semi_skilled', 'low', '{billing_software,customer_service}'),
  ('event_setup',       '{"en":"Event setup","hi":"इवेंट सेटअप","kn":"ಕಾರ್ಯಕ್ರಮ ಸಿದ್ಧತೆ"}', 'unskilled', 'medium', '{event_setup,loading}'),
  ('event_staff',       '{"en":"Event staff","hi":"इवेंट स्टाफ","kn":"ಕಾರ್ಯಕ್ರಮ ಸಿಬ್ಬಂದಿ"}', 'unskilled', 'low', '{customer_service,event_setup}');
