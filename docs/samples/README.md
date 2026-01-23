# Sample payloads (redacted)

These JSON files are captured from SmartThings API responses to help with development and debugging.

Sensitive identifiers (account/home/device IDs and other unique identifiers) have been replaced with obvious placeholders like:

- `<REDACTED:DEVICE_ID:...>`
- `<REDACTED:LOCATION_ID>` / `<REDACTED:ROOM_ID>` / `<REDACTED:OWNER_ID>`
- `<REDACTED:PROFILE_ID>` / `<REDACTED:PARENT_DEVICE_ID>`
- `<REDACTED:ENDPOINT_APP_ID>` / `<REDACTED:UNIQUE_IDENTIFIER>`
- `<REDACTED:TIMEZONE>`

The goal is to keep the response _shape_ intact (capabilities, categories, status structures) while removing anything that could identify a specific home/account.
