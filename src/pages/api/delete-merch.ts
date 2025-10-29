// src/pages/api/delete-merch.ts
import type { APIRoute } from 'astro';
import { v2 as cloudinary } from 'cloudinary';

export const POST: APIRoute = async ({ request }) => {
  try {
    const { productId } = await request.json();
    
    if (!productId) {
      return new Response(JSON.stringify({ error: 'Product ID required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    cloudinary.config({
      cloud_name: 'dscqbze0d',
      api_key: '555922422486159',
      api_secret: '1OV_96Pd_x7MSdt7Bph5aNELYho',
    });

    console.log('=== Starting Product Deletion ===');
    console.log('Product ID:', productId);

    // Step 1: Get current products.json
    const info = await cloudinary.api.resource('merch/products.json', {
      resource_type: 'raw'
    });
    
    const version = info.version;
    const productsUrl = `https://res.cloudinary.com/dscqbze0d/raw/upload/v${version}/merch/products.json`;
    
    const response = await fetch(productsUrl);
    const products = await response.json();

    // Step 2: Find the product to delete
    const productIndex = products.findIndex((p: any) => p.id === productId);
    
    if (productIndex === -1) {
      return new Response(JSON.stringify({ error: 'Product not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const productToDelete = products[productIndex];
    console.log('Found product:', productToDelete);

    // Step 3: Delete image from Cloudinary
    try {
      console.log('Deleting image:', productToDelete.image_public_id);
      await cloudinary.uploader.destroy(productToDelete.image_public_id, {
        resource_type: 'image',
        invalidate: true
      });
      console.log('Image deleted successfully');
    } catch (error) {
      console.error('Failed to delete image:', error);
    }

    // Step 4: Delete metadata file
    try {
      const metadataPublicId = `${productToDelete.folder_path}/metadata`;
      console.log('Deleting metadata:', metadataPublicId);
      await cloudinary.uploader.destroy(metadataPublicId, {
        resource_type: 'raw',
        invalidate: true
      });
      console.log('Metadata deleted successfully');
    } catch (error) {
      console.error('Failed to delete metadata:', error);
    }

    // Step 5: Delete folder
    try {
      console.log('Deleting folder:', productToDelete.folder_path);
      await cloudinary.api.delete_folder(productToDelete.folder_path);
      console.log('Folder deleted successfully');
    } catch (error) {
      console.error('Failed to delete folder:', error);
    }

    // Step 6: Remove product from array
    products.splice(productIndex, 1);

    // Step 7: Upload updated products.json
    console.log('Updating products.json...');
    const productsJson = JSON.stringify(products, null, 2);
    const productsBytes = Buffer.from(productsJson);

    await new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          resource_type: 'raw',
          public_id: 'merch/products.json',
          use_filename: true,
          unique_filename: false,
          overwrite: true,
          invalidate: true,
        },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      );
      uploadStream.end(productsBytes);
    });

    console.log('=== Product Deletion Complete ===');

    return new Response(JSON.stringify({
      success: true,
      message: 'Product deleted successfully',
      deletedProductId: productId,
      remainingProducts: products.length
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('=== Product Deletion Error ===');
    console.error(error);
    
    return new Response(JSON.stringify({
      error: 'Failed to delete product',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
