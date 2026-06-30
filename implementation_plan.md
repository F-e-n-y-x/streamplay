# StreamPlay API Implementation Plan

## Goal Description
The goal is to port the StreamPlay Kotlin plugin (used in CloudStream3) into a standalone, fully functioning, and well-documented REST API. This API will allow users to search for movies, TV shows, and anime, fetch their metadata, and extract streaming links (video and subtitles) from various providers concurrently, mimicking the exact behavior of the original StreamPlay plugin.

> [!NOTE]
> The original StreamPlay plugin is massive (~50 providers and 5700+ lines of Kotlin scraping code). Porting every single provider at once would be highly error-prone. We will implement a robust core framework, the TMDB metadata engine, and a set of the most reliable and primary providers first to ensure a "proper working API". Additional providers can be plugged in seamlessly due to the modular architecture.

## User Review Required

> [!IMPORTANT]
> 1. **Technology Stack:** I propose using **Node.js, Express, and TypeScript** with `axios` and `cheerio` for scraping. This is the industry standard for this type of API (similar to Consumet) and ensures high performance with concurrent requests.
> 2. **Provider Scope:** I will initially port the most reliable and popular providers from the repository (e.g., `2Embed`, `KissKH`, `AniNeko`/`HiAnime` for Anime, and a few multi-providers like `MultiMovies` or `ZShow`). Porting all 50+ providers will take significant time; we can add more iteratively once the core API is tested and working. Let me know if you have specific providers you want prioritized.
> 3. **TMDB API Key:** The original code uses a hardcoded TMDB API key. We will need a TMDB API key to fetch metadata. I will set it up to use an environment variable `TMDB_API_KEY`. I will use a dummy/public one for testing if available, but you may need to provide yours in the `.env` file eventually.

## Open Questions
- Do you have a preference for the porting framework? (e.g., Python FastAPI vs Node.js Express)? I strongly recommend Node.js TypeScript.
- Are there any specific providers out of the 50 in `ProvidersList.kt` that you absolutely want included in the initial version?

## Proposed Architecture

The project will be built in the `e:\Project\streamplay-api` workspace.

### Core Modules
- **`src/index.ts`**: Express server entry point.
- **`src/routes/`**: API endpoint definitions.
- **`src/tmdb.ts`**: Logic ported from `StreamPlay.kt` to handle TMDB fetching, language resolution, and Anime ID mapping (using `api.ani.zip` and `malsync`).
- **`src/extractors/`**: Directory containing individual scraper modules (ported from `StreamPlayExtractor.kt`).
- **`src/types.ts`**: TypeScript interfaces for inputs and standardized outputs (Streams, Subtitles).

### API Endpoints
1. `GET /api/search?q={query}` - Returns search results from TMDB.
2. `GET /api/info?type={movie|tv}&id={tmdb_id}` - Returns detailed metadata, seasons, and episodes.
3. `GET /api/streams?type={movie|tv}&id={tmdb_id}&season={s}&episode={e}` - Runs the concurrent provider execution engine and returns streaming links and subtitles.

## Verification Plan
1. **Automated Setup:** Initialize the Node.js project, install dependencies (`express`, `axios`, `cheerio`, `typescript`), and compile.
2. **Metadata Verification:** Test the `/api/info` endpoint to ensure it correctly resolves TMDB IDs to Anime IDs (MAL/AniList) when appropriate.
3. **Stream Extraction Verification:** Test the `/api/streams` endpoint for a known Movie, TV Show, and Anime to ensure the extractors correctly fetch video `.m3u8` or `.mp4` links and subtitle tracks.
4. **Documentation:** Create a `README.md` or Swagger UI documenting how to run and consume the API.
