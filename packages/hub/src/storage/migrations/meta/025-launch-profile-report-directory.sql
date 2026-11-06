-- Migration 025: a launch profile can have its PowerShell report its directory (#839).
--
-- `Set-Location` moves PowerShell's location but not its process directory,
-- so an agent cannot read where a PowerShell terminal is (#834). A profile with
-- `report_directory` set has the hub say so in its SPAWN, and a Windows agent
-- then starts the profile's PowerShell with a prompt that reports its
-- directory, when the profile's arguments run nothing of their own.
--
-- Every profile already here reads 0, the column's default: the switch
-- changes the command line a shell starts with, and only its user turns it
-- on. No row is rewritten. A hub before #839, run again on the database,
-- ignores the column and starts every profile as it always did; a profile it
-- adds reads 0.

ALTER TABLE launch_profiles ADD COLUMN report_directory INTEGER NOT NULL DEFAULT 0;

INSERT INTO schema_version VALUES (25, datetime('now'));
