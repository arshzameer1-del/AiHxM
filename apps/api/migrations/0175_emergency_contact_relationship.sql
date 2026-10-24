-- BACKLOG53 - an emergency contact needs to say who the person is (spouse, parent, friend). Only meaningful for
-- contact_type = 'emergency_contact'; it stays empty for emails and phones. The Name of the person is the existing label.
ALTER TABLE employee_contacts ADD COLUMN IF NOT EXISTS relationship text;
