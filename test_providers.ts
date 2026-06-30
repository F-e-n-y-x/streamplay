import { VidlinkProvider } from './src/extractors/vidlink';
import { VidFastProvider } from './src/extractors/vidfast';
import { VidEasyProvider } from './src/extractors/videasy';
import { CineMacityProvider } from './src/extractors/cinemacity';

async function test() {
    const data = {
        id: 157336,
        title: "Interstellar",
        year: 2014,
        imdbId: "tt0816692",
        type: 'movie' as any,
        isAnime: false
    };
    
    // console.log("Testing Vidlink...");
    // const res1 = await VidlinkProvider.invoke(data);
    // console.log(JSON.stringify(res1, null, 2));

    // console.log("Testing VidFast...");
    // const res2 = await VidFastProvider.invoke(data);
    // console.log(JSON.stringify(res2, null, 2));

    // console.log("Testing VidEasy...");
    // const res3 = await VidEasyProvider.invoke(data);
    // console.log(JSON.stringify(res3, null, 2));

    console.log("Testing CineMacity...");
    const res4 = await CineMacityProvider.invoke(data);
    console.log(JSON.stringify(res4, null, 2));
}

test();
