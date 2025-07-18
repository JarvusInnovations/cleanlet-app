import 'package:cleanlet/components/inlet_intro.dart';
import 'package:cleanlet/views/photo_needed/upload_photo.dart';
import 'package:flutter/material.dart';
import 'package:map_launcher/map_launcher.dart';
import '../models/inlet.dart';

class InletPhotoNeed extends StatelessWidget {
  final Inlet inlet;

  const InletPhotoNeed({super.key, required this.inlet});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
        appBar: AppBar(title: Text(inlet.nickName)),
        body: SafeArea(
            child: Column(
          children: [
            Container(
                margin: const EdgeInsets.symmetric(horizontal: 20.0, vertical: 20.0),
                padding: const EdgeInsets.all(40.0),
                decoration: BoxDecoration(
                  color: Colors.grey[300],
                  borderRadius: BorderRadius.circular(10.0),
                ),
                child: const Center(child: Text("Photo Required", style: TextStyle(fontSize: 16, fontWeight: FontWeight.w500, color: Colors.grey)))),
            Container(margin: const EdgeInsets.symmetric(horizontal: 20.0), child: InletIntro(coords: Coords(inlet.geoLocation.latitude, inlet.geoLocation.longitude), description: inlet.description, address: inlet.address)),
            const Spacer(),
            Container(
                margin: const EdgeInsets.symmetric(horizontal: 10.0),
                child: OutlinedButton.icon(
                  onPressed: () async {
                    await Navigator.push(context, MaterialPageRoute(builder: (context) => UploadPhoto(inlet)));
                  },
                  icon: const Icon(Icons.camera_alt_sharp),
                  label: Text('Take Photo'),
                  style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(40)),
                )),
          ],
        )));
  }
}
