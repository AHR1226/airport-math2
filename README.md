# Airport Math v6

This version is designed to feel like a real phone app.

## What changed

- cleaner mobile-first layout
- sticky bottom recalculate bar
- installable PWA support
- saved profile + favorite trips
- automatic routing chain:
  1. Google Routes
  2. Mapbox Directions
  3. backup estimate only if both fail
- live airport security fetch for JFK / LGA / EWR

## Run locally

```bash
npm install
cp .env.example .env
npm start
```

Then open:

```text
http://localhost:3000
```

## Deploy so it works on your phone

You can deploy this to any Node-friendly host.

### Simplest deploy path
1. Put this folder in a Git repo
2. Push it to GitHub
3. Create a new web service on your host
4. Set build command to `npm install`
5. Set start command to `npm start`
6. Add env vars:
   - `GOOGLE_MAPS_API_KEY`
   - `MAPBOX_ACCESS_TOKEN`

After deploy, open the public URL on your phone.

## Install to phone

### iPhone
Open the deployed URL in Safari, tap Share, then Add to Home Screen

### Android
Open the deployed URL in Chrome, then install when prompted


v6.1 UI updates:
- removed destination override
- removed fallback transport time field
- removed save-as-favorite field
- simplified Before boarding options
- updated Timing style labels
- renamed Trip intelligence to Your Step-by-Step Trip
