export default {
  async fetch(request) {
    console.log("webhook test 123");
    return new Response("Worker OK");
  }
};
