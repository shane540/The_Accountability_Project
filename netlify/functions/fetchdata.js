export default async (req, context) => {
  const apiKey = process.env.MY_API_KEY; 
  
  // Replace this URL with your actual data API endpoint
  const apiURL = `https://api.open.fec.gov/v1{apiKey}`;

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
