export default async (req, context) => {
  const apiKey = process.env.MY_API_KEY; 
  
  // Fixed: Added the correct FEC endpoint and parameter format
  const apiURL = `https://api.open.fec.gov/v1/candidates/?api_key=${apiKey}&sort=name&per_page=20`;

  try {
    const response = await fetch(apiURL);
    const data = await response.json();

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
};

export const config = {
  path: "/api/fetchdata"
};
