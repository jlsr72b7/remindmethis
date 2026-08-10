# Automated Regression Suite

This folder contains release regression smoke tests for the web app using Playwright.

## Scenarios Included

- Authentication + landing screen access
- Create flow labels:
  - `Create Event` title for new flow
  - `Set event location address` toggle text
- Modify flow label:
  - `Modify Event` title for edit flow
- Reminder mode carry-over check:
  - Switching from `Default` to `Custom` should not erase generated reminders

## Prerequisites

Set these environment variables before running:

- `E2E_EMAIL` - test account email
- `E2E_PASSWORD` - test account password

Optional:

- `E2E_BASE_URL` - app URL (default: `http://127.0.0.1:8081`)
- `E2E_USE_EXISTING_SERVER=true` - use an already-running web server instead of starting one

## Run Locally

Install browsers once:

- `npm run test:regression:install`

Run suite:

- `npm run test:regression`

Run headed:

- `npm run test:regression:headed`

## Release Usage

Run this suite as a required pre-release gate. If it fails, treat it as a release blocker until fixed or explicitly waived.
