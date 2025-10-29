// src/pages/api/upload-merch-enhanced.ts
import type { APIRoute } from 'astro';
import { v2 as cloudinary } from 'cloudinary';

export const POST: APIRoute = async ({ request }) => {
  try {
    const formData = await request.formData();
    
    const productName = formData.get('productName') as string;
    const productType = formData.get('productType') as string;
    const categoryId = formData.get('categoryId') as string;
    const categoryName = formData.get('categoryName') as string;
    const price = parseFloat(formData.get('price') as string);
    const description = formData.get('description') as string;
    const sku = formData.get('sku') as string;
    const sizes = JSON.parse(formData.get('sizes') as string);
    const sizeStock = JSON.parse(formData.get('sizeStock') as string);
    const colors = JSON.parse(formData.get('colors') as string);
    const imageCount = parseInt(formData.get('imageCount') as string);

    console.log('=== Enhanced Merch Upload Started ===');
    console.log('Product:', productName);
    console.log('Images to upload:', imageCount);
    console.log('Colors:', colors);

    if (!productName || !productType || !categoryId || !price || !sizes.length || imageCount === 0) {
      return new Response(JSON.stringify({ error: 'Missing required fields' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    cloudinary.config({
      cloud_name: 'dscqbze0d',
      api_key: '555922422486159',
      api_secret: '1OV_96Pd_x7MSdt7Bph5aNELYho',
    });

    // Generate product ID and paths
    const productId = `${productType}-${categoryId}-${Date.now()}`;
    const folderPath = `merch/${productType}/${categoryId}/${productId}`;
    const generatedSku = sku || `${productType.toUpperCase()}-${Date.now()}`;

    console.log('Product ID:', productId);
    console.log('Folder path:', folderPath);

    // Upload all images
    const uploadedImages = [];
    
    for (let i = 0; i < imageCount; i++) {
      const imageFile = formData.get(`imageFile${i}`) as File;
      
      if (!imageFile) continue;
      
      console.log(`Uploading image ${i + 1}/${imageCount}...`);
      
      const imageBuffer = await imageFile.arrayBuffer();
      const imageBytes = Buffer.from(imageBuffer);

      const imageUploadResult = await new Promise<any>((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          {
            resource_type: 'image',
            folder: folderPath,
            public_id: `image-${i}`,
            overwrite: true,
          },
          (error, result) => {
            if (error) reject(error);
            else resolve(result);
          }
        );
        uploadStream.end(imageBytes);
      });

      uploadedImages.push({
        url: imageUploadResult.secure_url,
        publicId: imageUploadResult.public_id,
        index: i,
        isPrimary: i === 0
      });

      console.log(`Image ${i + 1} uploaded successfully`);
    }

    // Calculate total stock
    const totalStock = Object.values(sizeStock).reduce((sum: number, stock: any) => sum + stock, 0);

    // Create product object
    const productData = {
      id: productId,
      name: productName,
      sku: generatedSku,
      type: productType,
      categoryId: categoryId,
      categoryName: categoryName,
      price: price,
      description: description,
      images: uploadedImages,
      primaryImage: uploadedImages[0].url, // For backward compatibility
      image: uploadedImages[0].url, // For backward compatibility
      image_public_id: uploadedImages[0].publicId, // For backward compatibility
      colors: colors,
      sizes: sizes,
      sizeStock: sizeStock,
      stock: totalStock,
      folder_path: folderPath,
      created_date: new Date().toISOString(),
      updated_date: new Date().toISOString(),
    };

    console.log('Product data created');

    // Get or create products.json
    let products = [];
    
    try {
      const info = await cloudinary.api.resource('merch/products.json', {
        resource_type: 'raw'
      });
      
      const version = info.version;
      const productsUrl = `https://res.cloudinary.com/dscqbze0d/raw/upload/v${version}/merch/products.json`;
      
      const response = await fetch(productsUrl);
      if (response.ok) {
        products = await response.json();
      }
    } catch (error) {
      console.log('No existing products.json, creating new one');
    }

    // Add new product
    products.push(productData);

    console.log('Uploading products.json...');

    // Upload updated products.json
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
        },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      );
      uploadStream.end(productsBytes);
    });

    // Upload metadata file for this product
    console.log('Uploading metadata...');
    const metadataJson = JSON.stringify(productData, null, 2);
    const metadataBytes = Buffer.from(metadataJson);

    await new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          resource_type: 'raw',
          folder: folderPath,
          public_id: 'metadata',
          overwrite: true,
        },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      );
      uploadStream.end(metadataBytes);
    });

    console.log('=== Enhanced Merch Upload Complete ===');

    return new Response(JSON.stringify({
      success: true,
      message: 'Product uploaded successfully',
      product: productData
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('=== Enhanced Merch Upload Error ===');
    console.error(error);
    
    return new Response(JSON.stringify({
      error: 'Failed to upload product',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};